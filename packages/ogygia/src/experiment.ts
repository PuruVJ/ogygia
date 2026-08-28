/**
 * `experiment()` — the assignment primitive. Splits, flags, targeting, rollouts, and canaries
 * are ONE thing: variants of something, assigned per visitor. This module owns ASSIGNMENT only;
 * branching rides the primitives ogygia already has (a router page's component pick, a load's
 * data branch, a region choice), and measurement rides `stamp()` + whatever the app logs.
 *
 * Precedence per request: QA override (`?og-exp=name:variant`) → carried assignment (a shell
 * that computed buckets upstream — dormant until something writes the claims symbol) →
 * `assign(c)` (any condition) → sticky hash split → control (the first variant).
 *
 * Assignment is deterministic and ZERO-JS: it happens server-side during SSR, and the chosen
 * variant is simply what gets rendered — csr=false pages experiment for free.
 */
import { DEV } from 'esm-env';
import { fnv1a32 } from './runtime/fingerprint.js';

type CtxLike = {
	request: Request;
	url: URL;
	cookies?: { get(name: string): string | undefined };
	/** The router's ONE identity (`routes(table, { visitor })`) — read first when present. Open
	 *  shape (matches the router's `Visitor`): `assign` callbacks read app claims off it. */
	visitor?: Record<string, unknown> & { sub?: string };
};

/** Written by an upstream shell's identity hop (the MFE fragment feature); absent = tier skipped. */
const CLAIMS = Symbol.for('ogygia.claims.v1');

/** 0..9999 — the sticky hash bucket for (salt, visitor). Bucketing needs uniform + deterministic,
 *  not cryptographic; the shared pure hash keeps this module safe in ANY bundle. */
const pct = (s: string) => fnv1a32(s) % 10000;

/** Who is this? The router's ONE identity (`c.visitor` — which itself folds in carried claims)
 *  when present; the raw claims/cookie fallbacks cover non-router contexts (a bare handle, a
 *  test). Anonymous → '' (splits degrade to control there — set an `og-vid` cookie for
 *  anonymous stickiness). */
function visitor(c: CtxLike): string {
	if (c.visitor?.sub) return c.visitor.sub;
	const claims = (c.request as unknown as Record<symbol, { sub?: string } | undefined>)[CLAIMS];
	return claims?.sub ?? c.cookies?.get('og-vid') ?? '';
}

/** Carried assignments: an upstream shell computed once; every consumer reads the same world. */
function carried(c: CtxLike, name: string): string | undefined {
	const claims = (
		c.request as unknown as Record<symbol, { experiments?: Record<string, string> } | undefined>
	)[CLAIMS];
	return claims?.experiments?.[name];
}

/** Are `?og-exp` overrides honored for THIS request? Dev: always. Prod: NEVER by default — an
 *  open URL override in production lets any visitor force themselves into unfinished features
 *  and pollute experiment data (the industry ships SIGNED overrides for exactly this reason).
 *  Opt production QA in via {@link allowOverrides} with something unforgeable. */
let override_gate: (c: CtxLike) => boolean = () => DEV;

/** Opt `?og-exp` overrides in beyond dev — gate on something a visitor can't forge: a session
 *  role, a signed QA cookie. Called once at server startup (hooks.server / the router module):
 *  `allowOverrides((c) => c.visitor?.roles?.includes('qa') ?? false)`. Applies to every
 *  experiment and flag in this server. */
export function allowOverrides(gate: (c: CtxLike) => boolean): void {
	override_gate = gate;
}

/** The EXPOSURE sink — called once per (request, experiment/flag) on first assignment, with
 *  `(name, variant, c)`. ogygia deliberately ships no metrics pipeline: this is the one seam —
 *  log it, queue it, POST it to your analytics; the stamp is the join key. Register once at
 *  server startup; `null` clears. Server-side, synchronous entry (fire-and-forget your own
 *  async inside), and a throwing sink never breaks a request. */
let exposure_sink: ((name: string, variant: string, c: CtxLike) => void) | null = null;
export function onExposure(sink: ((name: string, variant: string, c: CtxLike) => void) | null): void {
	exposure_sink = sink;
}

/** QA override: `?og-exp=csr-mode:hydrated` (repeatable / comma-separable). Gated — see
 *  {@link allowOverrides}. (An upstream shell that HONORED an override still propagates it to
 *  mounted teams through carried claims — the gate is per evaluating server.) */
function override(c: CtxLike, name: string): string | undefined {
	if (!override_gate(c)) return undefined;
	for (const raw of c.url.searchParams.getAll('og-exp')) {
		for (const pair of raw.split(',')) {
			const [n, v] = pair.split(':');
			if (n === name && v) return v;
		}
	}
	return undefined;
}

// ── layers: mutual exclusion ─────────────────────────────────────────────────────────────────
export interface Layer {
	readonly name: string;
	/** @internal */ members: string[];
	/** @internal which member experiment owns this visitor (equal slices; others see control). */
	member_for(v: string): string | undefined;
}

/** Experiments in one layer PARTITION traffic — each visitor lands in at most one of them
 *  (two hero redesigns must never hit the same visitor, or neither is measurable). */
export function layer(name: string): Layer {
	const members: string[] = [];
	return {
		name,
		members,
		member_for(v: string) {
			if (members.length === 0) return undefined;
			return members[pct(`layer:${name}:${v}`) % members.length];
		}
	};
}

// ── the primitive ────────────────────────────────────────────────────────────────────────────
export interface ExperimentOptions<V extends string> {
	variants: readonly [V, ...V[]];
	/** Percent of traffic per non-control variant (sticky hash); the remainder is control. */
	split?: Partial<Record<V, number>>;
	/** Any condition — cookies, claims, locale, URL. Return a variant, or `undefined` to fall
	 *  through to the split. A feature flag is an experiment whose assigner never falls through;
	 *  a beta program is `assign` first with `split` as the everyone-else tail. */
	assign?: (c: CtxLike) => V | undefined;
	/** Mutual-exclusion group. */
	layer?: Layer;
}

/** A per-request component chooser for `page()` — `page(exp.pick({ a: A, b: B }), { load })`.
 *  Branded (not a bare function) because Svelte 5 components ARE functions. */
export interface ComponentPick {
	__ogpick: (c: CtxLike) => unknown;
}

export interface Experiment<V extends string = string> {
	readonly name: string;
	readonly variants: readonly V[];
	/** This request's variant — deterministic + sticky; override→carried→assign→split→control. */
	bucket(c: CtxLike): V;
	/** Branch a router page's COMPONENT by variant. `$infer` is load-derived, so arms are free. */
	pick(map: Record<V, unknown>): ComponentPick;
	/** `name:variant` — for `data-og-exp` stamps, logs, Server-Timing labels. */
	stamp(c: CtxLike): string;
}

export function experiment<V extends string>(
	name: string,
	opts: ExperimentOptions<V>
): Experiment<V> {
	const control = opts.variants[0];
	if (opts.layer) opts.layer.members.push(name);

	// Per-REQUEST memo: bucket(c) runs up to once per read site (pick + stamp + every mount's
	// auto-carry), each re-walking ?og-exp and re-hashing. Assignment is deterministic within a
	// request, so key it on the Request (Weak — GC'd with the request, nothing leaks at scale).
	const memo = new WeakMap<Request, V>();

	const bucket = (c: CtxLike): V => {
		const cached = memo.get(c.request);
		if (cached !== undefined) return cached;
		const v = compute(c);
		memo.set(c.request, v);
		// EXPOSURE fires on the first computation per request — under SSR, assignment IS
		// rendering the variant, so first-read ≈ the visitor met the experience. Once per
		// (request, experiment); a throwing sink must never break the page.
		if (exposure_sink) {
			try {
				exposure_sink(name, v, c);
			} catch {
				/* the sink is app code — its failure is not the request's problem */
			}
		}
		return v;
	};

	const compute = (c: CtxLike): V => {
		const o = override(c, name);
		if (o && (opts.variants as readonly string[]).includes(o)) return o as V;
		const carried_v = carried(c, name);
		if (carried_v && (opts.variants as readonly string[]).includes(carried_v))
			return carried_v as V;
		const v = visitor(c);
		// layer gate: not this experiment's visitor → control (no assign, no split)
		if (opts.layer && opts.layer.member_for(v) !== name) return control;
		const assigned = opts.assign?.(c);
		if (assigned !== undefined) return assigned;
		if (opts.split && v) {
			const h = pct(`${name}:${v}`);
			let floor = 0;
			for (const variant of opts.variants) {
				if (variant === control) continue;
				const share = (opts.split[variant] ?? 0) * 100; // percent → basis points
				if (h >= floor && h < floor + share) return variant;
				floor += share;
			}
		}
		return control;
	};

	return {
		name,
		variants: opts.variants,
		bucket,
		pick: (map) => ({ __ogpick: (c) => map[bucket(c)] ?? map[control] }),
		stamp: (c) => `${name}:${bucket(c)}`
	};
}

// ── flag(): the boolean face of the same primitive ───────────────────────────────────────────
export interface FlagOptions {
	/** Targeting: `true` = feature ON for this request, `false` = definitively OFF (a targeted
	 *  off is NOT re-included by `rollout`), `undefined` = fall through to the rollout split.
	 *  A plain per-request function — read cookies, claims, env, a DB row: runtime toggles
	 *  without a redeploy are just what this function returns. */
	enabled?: (c: CtxLike) => boolean | undefined;
	/** Sticky percent of remaining traffic that gets the feature (0–100). Anonymous visitors
	 *  stay off (no identity to stick to — set an `og-vid` cookie for anonymous stickiness). */
	rollout?: number;
}

/** A feature flag IS an `Experiment<'off' | 'on'>` — same precedence chain (override → carried →
 *  enabled → rollout → off), same stickiness, listable in `routes({ experiments })` so mounts
 *  auto-carry it, same `?og-exp=name:on` QA override, `pick()` for page branching — plus `on(c)`
 *  so call sites read as booleans. */
export interface Flag extends Experiment<'off' | 'on'> {
	/** Does THIS request get the feature? */
	on(c: CtxLike): boolean;
}

export function flag(name: string, opts: FlagOptions = {}): Flag {
	const exp = experiment(name, {
		variants: ['off', 'on'],
		...(opts.enabled
			? {
					assign: (c: CtxLike) => {
						const e = opts.enabled!(c);
						return e === undefined ? undefined : e ? ('on' as const) : ('off' as const);
					}
				}
			: {}),
		...(opts.rollout ? { split: { on: opts.rollout } } : {})
	});
	return { ...exp, on: (c) => exp.bucket(c) === 'on' };
}
