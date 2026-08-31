/**
 * `flag()` — the ONE assignment primitive. A kill switch, a rollout, a targeting rule, and an
 * A/B/n test are the same thing: a name with variants, decided per visitor. This module owns the
 * DECISION only; branching rides `flag.pick()` (a router page slot, or a value map), measurement
 * rides the exposure sink, and vendor integration rides `decide({ source })`.
 *
 * Decision order per request (deterministic, sticky, ZERO-JS — it runs server-side during SSR and
 * the chosen variant is simply what gets rendered, so csr=false pages A/B for free):
 *   ?og-exp override (gated) → carried claims (a shell decided upstream) → the SOURCE
 *   (OpenFeature / OFREP / any resolver, primed once per request) → the native rule
 *   (targeting fn / weights) → the first variant (control / off).
 *
 * Everything the old surface split across `experiment` / `flag` / `layer` / `allowOverrides` /
 * `onExposure` / `batchExposures` / `.bucket` / `.on` / `.stamp` collapses to: `flag()`, calling
 * it, `.pick()`, `.value()`, and one `decide()`.
 */
import { DEV } from 'esm-env';
import { fnv1a32 } from './runtime/fingerprint.js';
import type { StandardSchemaV1 } from './router/view.js';

export type CtxLike = {
	request: Request;
	url: URL;
	cookies?: { get(name: string): string | undefined };
	/** The router's ONE identity (`routes(table, { visitor })`) — read first when present. Open
	 *  shape (matches the router's `Visitor`): a targeting fn reads app claims off it. */
	visitor?: (Record<string, unknown> & { sub?: string }) | undefined;
};

/** Written by an upstream shell's identity hop (the fragment feature); absent = the tier is skipped. */
const CLAIMS = Symbol.for('ogygia.claims.v1');
/** Per-request source resolution, cached on the Request (GC'd with it). */
const RESOLVED = Symbol.for('ogygia.flags.resolved.v1');
/** Per-request set of (name → decided variant) — powers federation auto-carry + primed-guard. */
const ASSIGNED = Symbol.for('ogygia.flags.assigned.v1');

/** 0..9999 — sticky hash bucket for (salt, visitor). Uniform + deterministic, not cryptographic;
 *  the shared pure hash keeps this module safe in ANY bundle (runtime + every island entry). */
const pct = (s: string) => fnv1a32(s) % 10000;

/** Who is this? The router identity (folds in carried claims) when present; raw claims / `og-vid`
 *  cookie otherwise. Anonymous → '' (weights degrade to the first variant there). */
function visitor_id(c: CtxLike): string {
	if (c.visitor?.sub) return c.visitor.sub;
	const claims = (c.request as unknown as Record<symbol, { sub?: string } | undefined>)[CLAIMS];
	return claims?.sub ?? c.cookies?.get('og-vid') ?? '';
}

function carried(c: CtxLike, name: string): string | undefined {
	const claims = (
		c.request as unknown as Record<symbol, { experiments?: Record<string, string> } | undefined>
	)[CLAIMS];
	return claims?.experiments?.[name];
}

// ── decide(): the ONE setup call ─────────────────────────────────────────────────────────────

/** One decided flag from the SOURCE: a variant name (validated against the flag's declared
 *  variants), optionally with a vendor-authored value (validated against the flag's `value`
 *  schema). A bare boolean/string is accepted too — sugar for `{ variant }`. */
export type Resolved = { variant: string; value?: unknown } | string | boolean;

/** What the source is asked to decide — the app's flags for this request. */
export interface FlagQuery {
	name: string;
	variants: readonly string[];
	/** `'boolean'` for a kill switch / rollout / targeting flag, `'variant'` for a weighted set. */
	kind: 'boolean' | 'variant';
}

/** A decision source — OpenFeature, OFREP, or any function. Given the app's flags + the request
 *  context, return each flag's decision (missing keys fall through to the native rule). Resolved
 *  ONCE per request (awaited by `handle()` / the router), so every read stays sync. */
export type FlagSource = (
	queries: FlagQuery[],
	c: CtxLike
) => Record<string, Resolved> | Promise<Record<string, Resolved>>;

export interface ExposureEvent {
	name: string;
	variant: string;
	/** the sticky identity the decision keyed on (undefined = anonymous) */
	sub?: string;
	at: number;
}

export interface DecideOptions {
	/** Where decisions come from (a vendor). Omit for pure-native flags (still sticky + zero-JS). */
	source?: FlagSource;
	/** Honor `?og-exp=name:variant` beyond dev — gate on something a visitor can't forge (a session
	 *  role, a signed QA cookie). Default: dev only. */
	overrides?: (c: CtxLike) => boolean;
	/** Exposure sink — called with a BATCH of events (batching is built in: flushed at `max`
	 *  events, after `ms`, or at each request's end). A throwing sink never breaks a request. */
	exposure?: (events: ExposureEvent[]) => void | Promise<void>;
	/** Exposure batch size / age caps. Defaults: `max` 25, `ms` 2000. */
	batch?: { max?: number; ms?: number };
}

let _source: FlagSource | null = null;
let _override_gate: (c: CtxLike) => boolean = () => DEV;
let _exposure: ((events: ExposureEvent[]) => void | Promise<void>) | null = null;
let _batch = { max: 25, ms: 2000 };
let _queue: ExposureEvent[] = [];
let _timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Configure flags for this server, once (hooks.server.ts / any server module). Everything is
 * optional — with no `decide()` at all, flags are native, sticky, and zero-JS.
 *
 *   decide({ source: openfeature(client), overrides: (c) => !!c.visitor?.qa, exposure: send });
 */
export function decide(opts: DecideOptions): void {
	if ('source' in opts) _source = opts.source ?? null;
	if (opts.overrides) _override_gate = opts.overrides;
	if ('exposure' in opts) _exposure = opts.exposure ?? null;
	if (opts.batch) _batch = { max: opts.batch.max ?? 25, ms: opts.batch.ms ?? 2000 };
}

function emit_exposure(e: ExposureEvent): void {
	if (!_exposure) return;
	_queue.push(e);
	if (_queue.length >= _batch.max) flush_exposures();
	else if (!_timer) _timer = setTimeout(flush_exposures, _batch.ms);
}

/** Drain queued exposures to the sink. Called at each request's end (serverless-safe tail) and on
 *  the size/age caps. A sink failure is contained — a lost batch is never a request's problem. */
export function flush_exposures(): void {
	if (_timer) clearTimeout(_timer);
	_timer = null;
	if (_queue.length === 0) return;
	const batch = _queue;
	_queue = [];
	try {
		void _exposure?.(batch);
	} catch {
		/* analytics problem, never a request problem */
	}
}

// ── registry + per-request source priming ────────────────────────────────────────────────────

/** Every constructed flag self-registers here — the complete name list a source is asked for, and
 *  the set federation auto-carries. Import your flags (route modules do this at startup; on plain
 *  Kit, `import './flags'` in hooks.server.ts to prime the source from the first request). */
const _registry = new Map<string, FlagQuery>();

/**
 * Resolve the source ONCE per request over every registered flag, caching decisions on the
 * Request so reads stay sync. Awaited by `handle()` and the router dispatch (the two per-request
 * entry points). Idempotent; a no-op without a source. Never throws — a source failure degrades
 * every flag to its native rule, it does not take the request down.
 */
export async function prime_flags(c: CtxLike): Promise<void> {
	const req = c.request as unknown as Record<symbol, unknown>;
	if (!_source || req[RESOLVED] !== undefined) return;
	req[RESOLVED] = {}; // claim the slot up front (idempotent across concurrent primes)
	if (_registry.size === 0) return;
	try {
		const out = await _source([..._registry.values()], c);
		const map: Record<string, { variant: string; value?: unknown }> = {};
		for (const q of _registry.values()) {
			const raw = out?.[q.name];
			if (raw === undefined) continue;
			const norm =
				typeof raw === 'boolean'
					? { variant: raw ? 'on' : 'off' }
					: typeof raw === 'string'
						? { variant: raw }
						: raw;
			if (norm && q.variants.includes(norm.variant)) map[q.name] = norm;
		}
		req[RESOLVED] = map;
	} catch {
		req[RESOLVED] = {}; // source down → everything falls through to native
	}
}

function resolved_for(c: CtxLike, name: string): { variant: string; value?: unknown } | undefined {
	const map = (
		c.request as unknown as Record<symbol, Record<string, { variant: string; value?: unknown }>>
	)[RESOLVED];
	return map?.[name];
}

/** Record the decided variant for federation auto-carry (read by the router's `claims_for`). */
function record_assigned(c: CtxLike, name: string, variant: string): void {
	const req = c.request as unknown as Record<symbol, Record<string, string> | undefined>;
	(req[ASSIGNED] ??= {})[name] = variant;
}

/** The (name → variant) map a request has decided so far — federation carries it as signed claims. */
export function assigned_buckets(request: Request): Record<string, string> | undefined {
	return (request as unknown as Record<symbol, Record<string, string> | undefined>)[ASSIGNED];
}

// ── override (?og-exp) ───────────────────────────────────────────────────────────────────────

function override(c: CtxLike, name: string): string | undefined {
	if (!_override_gate(c)) return undefined;
	for (const raw of c.url.searchParams.getAll('og-exp')) {
		for (const pair of raw.split(',')) {
			const [n, v] = pair.split(':');
			if (n === name && v) return v;
		}
	}
	return undefined;
}

// ── layers: mutual exclusion (a `layer: 'name'` string option) ───────────────────────────────

const _layers = new Map<string, string[]>();
function layer_member_for(group: string, v: string): string | undefined {
	const members = _layers.get(group);
	if (!members || members.length === 0) return undefined;
	return members[pct(`layer:${group}:${v}`) % members.length];
}

// ── the primitive ────────────────────────────────────────────────────────────────────────────

/** A per-request component chooser for `page()` — `page(hero.pick({ control: A, bold: B }))`.
 *  Branded (not a bare function) because Svelte 5 components ARE functions. */
export interface ComponentPick {
	__ogpick: (c: CtxLike) => unknown;
}

/** Rare knobs (third arg to `flag`). */
export interface FlagOptions<Value = unknown> {
	/** Mutual-exclusion group: flags/experiments sharing a `layer` partition traffic — a visitor
	 *  lands in at most one (others see their first variant). */
	layer?: string;
	/** Standard Schema for a vendor-authored payload read via `.value(c)`. A vendor value that
	 *  fails the schema is IGNORED (never enters) — the same trust-boundary law as body schemas. */
	value?: StandardSchemaV1<Value>;
	/** Required alongside `value`: the payload when the source is silent or a value is invalid, so
	 *  `.value(c)` never returns undefined. */
	fallback?: Value;
}

/** The shape a flag is declared with (second arg):
 *  - omitted → a kill switch (off until decided on),
 *  - a number → sticky rollout percent (0–100) of the feature,
 *  - a function → per-request targeting (`true`/`false`, or `undefined` to fall through),
 *  - a record → weighted variants (ratios; the first key is control). */
export type FlagShape<V extends string> =
	| undefined
	| number
	| ((c: CtxLike) => boolean | undefined)
	| Record<V, number>;

interface FlagBase<Value> {
	readonly name: string;
	/** `name:variant` — for `data-og-exp` stamps, logs, Server-Timing labels. */
	stamp(c: CtxLike): string;
	/** Vendor-authored payload (validated by the `value` schema), else the `fallback`. */
	value(c: CtxLike): Value;
}

/** A boolean flag — calling it answers "does this request get the feature?". */
export interface BoolFlag<Value = unknown> extends FlagBase<Value> {
	(c: CtxLike): boolean;
	readonly variants: readonly ('off' | 'on')[];
	/** Page slot (no `c` — the router supplies it): `page(flag.pick({ … }))`. */
	pick(map: Record<'off' | 'on', unknown>): ComponentPick;
	/** Pick this visitor's entry from a per-variant map (`'off' | 'on'`), typed + total. */
	pick<T>(c: CtxLike, map: Record<'off' | 'on', T>): T;
}

/** A weighted-variant flag — calling it answers which variant this request gets. */
export interface VariantFlag<V extends string, Value = unknown> extends FlagBase<Value> {
	(c: CtxLike): V;
	readonly variants: readonly V[];
	/** Page slot (no `c` — the router supplies it): `page(flag.pick({ … }))`. */
	pick(map: Record<V, unknown>): ComponentPick;
	/** Pick this visitor's entry from a per-variant map, typed + total. */
	pick<T>(c: CtxLike, map: Record<V, T>): T;
}

// overloads: a record shape gives a VariantFlag<its keys>; everything else a BoolFlag.
export function flag<V extends string, Value = unknown>(
	name: string,
	shape: Record<V, number>,
	opts?: FlagOptions<Value>
): VariantFlag<V, Value>;
export function flag<Value = unknown>(
	name: string,
	shape?: number | ((c: CtxLike) => boolean | undefined),
	opts?: FlagOptions<Value>
): BoolFlag<Value>;
export function flag(
	name: string,
	shape?: FlagShape<string>,
	opts: FlagOptions = {}
): BoolFlag | VariantFlag<string> {
	const is_record = shape !== null && typeof shape === 'object';
	const variants: readonly string[] = is_record
		? (Object.keys(shape as Record<string, number>) as string[])
		: ['off', 'on'];
	const control = variants[0];
	const weights = is_record ? (shape as Record<string, number>) : null;
	const rollout = typeof shape === 'number' ? shape : null;
	const target =
		typeof shape === 'function' ? (shape as (c: CtxLike) => boolean | undefined) : null;

	_registry.set(name, {
		name,
		variants,
		kind: is_record ? 'variant' : 'boolean'
	});
	if (opts.layer) {
		const members = _layers.get(opts.layer) ?? [];
		if (!members.includes(name)) members.push(name);
		_layers.set(opts.layer, members);
	}

	const memo = new WeakMap<Request, string>();

	const compute = (c: CtxLike): string => {
		const o = override(c, name);
		if (o && variants.includes(o)) return o;
		const carried_v = carried(c, name);
		if (carried_v && variants.includes(carried_v)) return carried_v;
		const src = resolved_for(c, name);
		if (src) return src.variant;
		const v = visitor_id(c);
		if (opts.layer && layer_member_for(opts.layer, v) !== name) return control;
		if (target) {
			const t = target(c);
			if (t !== undefined) return t ? 'on' : 'off';
		}
		if (weights && v) {
			const total = Object.values(weights).reduce((a, b) => a + (b > 0 ? b : 0), 0);
			if (total > 0) {
				const h = (pct(`${name}:${v}`) / 10000) * total;
				let floor = 0;
				for (const variant of variants) {
					const share = weights[variant] > 0 ? weights[variant] : 0;
					if (h >= floor && h < floor + share) return variant;
					floor += share;
				}
			}
		}
		if (rollout && v) {
			const share = rollout * 100; // percent → basis points
			if (pct(`${name}:${v}`) < share) return 'on';
		}
		return control;
	};

	const bucket = (c: CtxLike): string => {
		const cached = memo.get(c.request);
		if (cached !== undefined) return cached;
		const variant = compute(c);
		memo.set(c.request, variant);
		record_assigned(c, name, variant);
		emit_exposure({ name, variant, sub: c.visitor?.sub, at: DEV ? 0 : now() });
		return variant;
	};

	const value = (c: CtxLike): unknown => {
		const raw = resolved_for(c, name)?.value;
		if (raw !== undefined && opts.value) {
			const r = opts.value['~standard'].validate(raw);
			// Standard Schema validate is sync for our purpose; a thenable or an issues[] → fall back.
			if (r && typeof (r as { then?: unknown }).then !== 'function') {
				const res = r as { value?: unknown; issues?: unknown };
				if (!res.issues) return res.value;
			}
		} else if (raw !== undefined && !opts.value) {
			return raw;
		}
		return opts.fallback;
	};

	const pick = (a: CtxLike | Record<string, unknown>, b?: Record<string, unknown>) => {
		if (b === undefined) {
			const map = a as Record<string, unknown>;
			return { __ogpick: (c: CtxLike) => map[bucket(c)] ?? map[control] };
		}
		return b[bucket(a as CtxLike)] ?? b[control];
	};

	const call = (c: CtxLike) => (is_record ? bucket(c) : bucket(c) === 'on');
	// A function's own `name`/`length` are read-only, so `defineProperties` (not `Object.assign`,
	// which throws on `name`) — and the flag's `name` shadows the function's.
	Object.defineProperties(call, {
		name: { value: name, enumerable: true },
		variants: { value: variants, enumerable: true },
		stamp: { value: (c: CtxLike) => `${name}:${bucket(c)}`, enumerable: true },
		value: { value, enumerable: true },
		pick: { value: pick, enumerable: true }
	});
	return call as unknown as BoolFlag | VariantFlag<string>;
}

/** `Date.now()` is unavailable in some sandboxes (workflow scripts); guard it so importing this
 *  module never throws there — exposure timestamps are 0 in that case (and in dev). */
function now(): number {
	try {
		return Date.now();
	} catch {
		return 0;
	}
}
