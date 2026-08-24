/**
 * THE HUB — ogygia's identity layer. One primitive carries everything that crosses an
 * island boundary:
 *
 *     Ref = { k: kind, i: identity, t: code tag, d: data }
 *
 * A held region, a portable snippet, a store, a `[og.wire]` class, a hoisted function —
 * each is a Ref of a different KIND. A kind teaches the hub how its values travel
 * (`match`/`encode`/`decode`); the hub owns everything identity:
 *
 *  - MINT: every live instance gets ONE id (WeakMap-memoized), however many props or
 *    context keys carry it — which is what lets the client reunite all copies.
 *  - RESOLVE: the browser memoizes decode by id (`remember: true`), so five islands
 *    decoding one handle share ONE live object. The server never memoizes
 *    (`remember: false`): each request decodes fresh — nothing leaks between users.
 *  - THE KEEP: a kind may name a ref for SESSION continuity (`keep_name`); the tab then
 *    reunites navigations with the same live instance, reconciling fresh server data via
 *    the kind's `merge`. Browser-only; the server never touches it.
 *
 * Everything interesting in the framework is an operation on `i`, not `d`: reunify across
 * islands = same id; survive a navigation = same id in the Keep; dedupe = same id; the
 * future region reconciler = diff two id sets. Kinds are plugins; identity is the spine.
 *
 * All registry state lives on `globalThis` under `Symbol.for` keys — the runtime and each
 * island entry are separate bundles, and per-module state would silently fork.
 */

/** The wire shape. `k` picks the kind, `i` is identity, `t` names code (module tag /
 *  chunk / factory), `d` is devalue-safe data (value, snapshot, props, bound captures). */
export interface Ref {
	k: string;
	i: string;
	t?: string;
	d?: unknown;
	/** Scope hint (hub v2, phase S) — which lifetime bucket governs this instance:
	 *  'request' (server, never memoized) | 'page' (this render) | 'session' (cross-nav, tab).
	 *  Optional on the wire; when absent, resolve derives it (keep_name ⇒ session, else the
	 *  caller's page/request choice). Present so a scope can be DISPOSED as a unit (phase D). */
	sc?: Scope;
}

/** The three identity lifetimes, one axis of the hub's policy space. */
export type Scope = 'request' | 'page' | 'session';

/** A kind teaches the hub one family of transportable values. */
export interface RefKind {
	/** Kind discriminator carried in `Ref.k` ('wire' | 'store' | 'snippet' | 'region' | 'fn' | …). */
	k: string;
	/** Claim a live value (mint dispatch, first registered wins). */
	match(value: unknown): boolean;
	/** Sending side: code tag + devalue-safe data. */
	encode(value: object): { t?: string; d?: unknown };
	/** Receiving side: rebuild a live value from the ref. */
	decode(ref: Ref): unknown;
	/** SESSION continuity: name this ref to promote its instance to tab lifetime (browser only). */
	keep_name?(ref: Ref): string | undefined;
	/** Reconcile a kept live instance with a freshly arrived ref (default: kept wins untouched). */
	merge?(kept: object, ref: Ref): void;
	/** Tear down a live instance when its scope is disposed (hub v2, phase D) — close a channel,
	 *  abort a fetch, drop a subscription. Most kinds have nothing to release (GC handles the
	 *  object); implement only when the instance owns a resource beyond memory. */
	dispose?(live: object): void;
}

interface HubRegistry {
	/** kind discriminator → kind (decode dispatch). */
	kinds: Map<string, RefKind>;
	/** mint dispatch order (registration order; first match wins). */
	order: RefKind[];
	/** live instance → minted id (one id per instance, however many carriers). */
	ids: WeakMap<object, string>;
	/** THE SCOPED STORE (hub v2, phase S) — scope → (key → live instance). ONE structure that
	 *  replaces the old `live` (now the 'page' bucket, keyed by ref.i) and `keep` (the 'session'
	 *  bucket, keyed by continuity name). 'request' is never populated — the server decodes fresh.
	 *  A whole scope can be disposed as a unit (phase D). Browser tab only. */
	instances: Map<Scope, Map<string, object>>;
	/** live instance → its kind discriminator, so scope disposal can dispatch `kind.dispose`
	 *  without storing the kind inline in every bucket entry. Weak — never pins an instance. */
	instance_kind: WeakMap<object, string>;
	/** side-effectful cleanups to run when a scope is disposed (hub v2, phase D) — e.g. the remote
	 *  cache clearing its page-scoped seeds on nav. Keyed by scope. */
	scope_disposers: Map<Scope, Set<() => void>>;
	/** continuity name → owning code tag (collision guard: one name, one kind of thing). */
	keep_owner: Map<string, string>;
	/** WATCHERS — id → callbacks fired when fresh data SETTLES for that id (hub v2, phase W).
	 *  Browser only; the request-scoped server path never watches. */
	watchers: Map<string, Set<(live: unknown) => void>>;
}

import { emit as dt_emit } from './devtools/bus.js';

// DEVTOOLS gate — module-local const from the Vite `define` (proven DCE pattern); off → folds out.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;

const REGISTRY_KEY = Symbol.for('ogygia.hub');

function registry(): HubRegistry {
	const g = globalThis as Record<symbol, unknown>;
	return ((g[REGISTRY_KEY] as HubRegistry | undefined) ??= {
		kinds: new Map(),
		order: [],
		ids: new WeakMap(),
		instances: new Map([
			['page', new Map()],
			['session', new Map()]
		]),
		instance_kind: new WeakMap(),
		scope_disposers: new Map(),
		keep_owner: new Map(),
		watchers: new Map()
	});
}

/** Register a kind. Idempotent by discriminator — a re-registration (second bundle evaluating
 *  the same module) keeps the FIRST, so identity state never forks. */
export function register_kind(kind: RefKind): void {
	const reg = registry();
	if (reg.kinds.has(kind.k)) return;
	reg.kinds.set(kind.k, kind);
	reg.order.push(kind);
}

function mint_id(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return 'r' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

/**
 * Mint: live value → Ref, or undefined to fall through to devalue's normal handling.
 * `only` restricts the dispatch to named kinds — a seam may deliberately exclude a family
 * (the drop-in context path excludes snippets so a stray function THROWS instead of being
 * silently mis-read as one). Same instance → same id, always.
 */
export function mint(value: unknown, only?: ReadonlySet<string>): Ref | undefined {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
		return undefined;
	const reg = registry();
	for (const kind of reg.order) {
		if (only && !only.has(kind.k)) continue;
		if (!kind.match(value)) continue;
		const { t, d } = kind.encode(value as object);
		let i = reg.ids.get(value as object);
		if (i === undefined) {
			i = mint_id();
			reg.ids.set(value as object, i);
		}
		const ref: Ref = { k: kind.k, i, d };
		if (t !== undefined) ref.t = t;
		if (DEVTOOLS) dt_emit({ domain: 'hub', name: 'hub.mint', kind: kind.k, id: i, tag: t });
		return ref;
	}
	return undefined;
}

/**
 * RESOLVE SINK (reconciler R3) — a hook the runtime installs during an island's hydration to learn
 * which page-scoped ids that island resolves, WITHOUT the hub knowing anything about the DOM.
 * `resolve()` calls the current sink with each id it freshly remembers in the page scope; the
 * runtime's sink attributes it to the island currently hydrating (region → id-set), so a reconcile
 * nav can dispose exactly the ids owned by REMOVED regions. Null when no island is hydrating.
 */
let resolve_sink: ((id: string) => void) | null = null;
export function set_resolve_sink(fn: ((id: string) => void) | null): void {
	resolve_sink = fn;
}

/** The live bucket for a scope (never 'request' — that scope is never stored). */
function bucket(reg: HubRegistry, scope: Scope): Map<string, object> {
	let b = reg.instances.get(scope);
	if (b === undefined) reg.instances.set(scope, (b = new Map()));
	return b;
}

/** Memoize an instance in a scope's bucket, recording its kind for later disposal. No MAX_LIVE
 *  cap since phase D — the 'page' bucket is emptied by `dispose_scope('page')` on every nav, so
 *  it can't creep across the tab's lifetime the way the old unbounded map could. */
function remember_in(
	reg: HubRegistry,
	scope: Scope,
	key: string,
	instance: object,
	kind_k: string
): void {
	bucket(reg, scope).set(key, instance);
	reg.instance_kind.set(instance, kind_k);
	// R3 ownership: tell the sink (if an island is hydrating) which page id it just resolved, so the
	// reconciler can dispose exactly the ids of REMOVED regions. Page scope only; `key` is the ref.i.
	if (scope === 'page' && resolve_sink !== null) resolve_sink(key);
}

/**
 * DISPOSE a whole scope (hub v2, phase D) — tear down every instance in its bucket via the
 * instance's `kind.dispose`, run any registered scope-disposers (side-effect cleanups like the
 * remote cache), then empty the bucket. `dispose_scope('page')` on nav is what replaces the old
 * MAX_LIVE cap: stale page-scoped aliases go, session/forever instances stay.
 *
 * SAFETY: a page-bucket instance that is ALSO in a longer-lived bucket (a wire class aliased into
 * 'session' for continuity) is NOT torn down — only its page alias is dropped. Its resources
 * belong to the session and outlive the nav.
 */
export function dispose_scope(scope: Scope): void {
	const reg = registry();
	const b = reg.instances.get(scope);
	if (DEVTOOLS)
		dt_emit({ domain: 'hub', name: 'hub.dispose', scope, count: b?.size ?? 0 });
	if (b !== undefined && b.size > 0) {
		// instances reachable from a longer-lived bucket must survive this disposal
		const survivors = new Set<object>();
		if (scope === 'page') for (const inst of bucket(reg, 'session').values()) survivors.add(inst);
		for (const inst of b.values()) {
			if (survivors.has(inst)) continue;
			const kind = reg.kinds.get(reg.instance_kind.get(inst) ?? '');
			try {
				kind?.dispose?.(inst);
			} catch {
				/* one instance's teardown throwing must not strand the rest */
			}
		}
		b.clear();
	}
	const ds = reg.scope_disposers.get(scope);
	if (ds !== undefined)
		for (const fn of [...ds]) {
			try {
				fn();
			} catch {
				/* a disposer throwing must not block the others */
			}
		}
}

/**
 * DISPOSE specific page-scoped ids (reconciler R3) — the SELECTIVE counterpart to dispose_scope.
 * A reconcile nav keeps matched islands mounted, so it can't blanket-dispose the page scope; it
 * disposes only the ids owned by REMOVED regions. Each id's instance is torn down via its
 * kind.dispose and removed from the page bucket, instance_kind, and dep_index — UNLESS it is also
 * session-aliased (continuity), in which case only nothing happens (the session bucket keeps it).
 * ids not present in the page bucket are skipped silently.
 */
export function dispose_ids(ids: Iterable<string>): void {
	const reg = registry();
	const page = bucket(reg, 'page');
	const survivors = new Set<object>(bucket(reg, 'session').values());
	let dt_disposed = 0;
	for (const id of ids) {
		const inst = page.get(id);
		if (inst === undefined) continue;
		page.delete(id);
		if (DEVTOOLS) dt_disposed++;
		if (survivors.has(inst)) continue; // session-aliased — its resources outlive the nav
		const kind = reg.kinds.get(reg.instance_kind.get(inst) ?? '');
		reg.instance_kind.delete(inst);
		try {
			kind?.dispose?.(inst);
		} catch {
			/* one instance's teardown throwing must not strand the rest */
		}
	}
	if (DEVTOOLS && dt_disposed > 0)
		dt_emit({ domain: 'hub', name: 'hub.dispose', scope: 'ids', count: dt_disposed });
}

/** Register a side-effect cleanup to run whenever `scope` is disposed. Returns an unregister fn.
 *  Lets subsystems (the remote cache) fold their nav-time clearing into scope disposal. */
export function register_scope_disposer(scope: Scope, fn: () => void): () => void {
	const reg = registry();
	let set = reg.scope_disposers.get(scope);
	if (set === undefined) reg.scope_disposers.set(scope, (set = new Set()));
	set.add(fn);
	return () => reg.scope_disposers.get(scope)?.delete(fn);
}

/**
 * Resolve: Ref → live value.
 *
 * Second arg is a {@link Scope} (or a legacy boolean shim: `true` ⇒ 'page', `false` ⇒ 'request').
 * 'page'/'session' (browser) memoize by id — decoding the same ref twice returns the SAME instance
 * (the liveness mechanism), and a kind-named ref reunites with the session bucket across
 * navigations (the kind's `merge` reconciles fresh server data in; default kept-wins). 'request'
 * (server, defer/streaming renders) always decodes fresh: memoizing across requests would leak one
 * user's state into another's HTML.
 */
export function resolve(ref: Ref, scope_or_remember: boolean | Scope): unknown {
	const scope: Scope =
		typeof scope_or_remember === 'boolean'
			? scope_or_remember
				? 'page'
				: 'request'
			: scope_or_remember;
	const remember = scope !== 'request';
	const reg = registry();
	if (remember) {
		const existing = bucket(reg, 'page').get(ref.i);
		if (existing !== undefined) {
			// WATCH path (hub v2, phase W): a re-resolve of a WATCHED id carrying fresh data folds
			// that data into the live instance (via the kind's merge) and notifies watchers — the
			// reactive graph resumes in place. With no watchers this is byte-for-byte the old
			// early-return, so reunification-by-identity (stores, snippets) is untouched.
			const w = reg.watchers.get(ref.i);
			if (w !== undefined && w.size > 0) {
				const kind = reg.kinds.get(ref.k);
				if (kind?.merge !== undefined) {
					kind.merge(existing, ref);
					notify(ref.i, existing);
				}
			}
			if (DEVTOOLS)
				dt_emit({ domain: 'hub', name: 'hub.resolve', kind: ref.k, id: ref.i, scope, tag: ref.t, hit: true });
			return existing;
		}
	}
	const kind = reg.kinds.get(ref.k);
	if (kind === undefined) {
		throw new Error(
			`[ogygia] cannot resolve a "${ref.k}" ref: no such kind is registered on this side. ` +
				`The module that registers it must be imported as a VALUE in this bundle.`
		);
	}

	if (remember) {
		const name = kind.keep_name?.(ref);
		if (typeof name === 'string') {
			// Collision guard: two different code tags claiming one continuity name would silently
			// reuse each other's instance. Warn (dev) — a continuity name must be unique per thing.
			const tag = ref.t ?? ref.k;
			const owner = reg.keep_owner.get(name);
			if (owner === undefined) reg.keep_owner.set(name, tag);
			else if (owner !== tag && typeof console !== 'undefined') {
				console.error(
					`[ogygia] two transportables both use continuity id "${name}" ("${owner}" and "${tag}"). ` +
						`A continuity id must be unique per class — rename one, or they will clobber each other in the session Keep.`
				);
			}
			const kept = bucket(reg, 'session').get(name);
			if (kept !== undefined) {
				kind.merge?.(kept, ref);
				// The session bucket is the source of truth for the name; this ref's id aliases it in
				// the page bucket too, so late-hydrating islands on the same page reunite with it.
				remember_in(reg, 'page', ref.i, kept, ref.k);
				if (DEVTOOLS)
					dt_emit({ domain: 'hub', name: 'hub.resolve', kind: ref.k, id: ref.i, scope, tag: ref.t, hit: true });
				return kept;
			}
			const instance = kind.decode(ref);
			if (instance !== null && typeof instance === 'object') {
				remember_in(reg, 'session', name, instance as object, ref.k);
				remember_in(reg, 'page', ref.i, instance as object, ref.k);
			}
			if (DEVTOOLS)
				dt_emit({ domain: 'hub', name: 'hub.resolve', kind: ref.k, id: ref.i, scope, tag: ref.t, hit: false });
			return instance;
		}
	}

	const instance = kind.decode(ref);
	if (remember && instance !== null && typeof instance === 'object') {
		remember_in(reg, 'page', ref.i, instance as object, ref.k);
	}
	if (DEVTOOLS)
		dt_emit({ domain: 'hub', name: 'hub.resolve', kind: ref.k, id: ref.i, scope, tag: ref.t, hit: false });
	return instance;
}

/**
 * WATCH — subscribe to fresh data settling for a hub id (hub v2, phase W). Returns an
 * unsubscribe fn. THE one subscription primitive: region frames, streamed page-data, live
 * refresh — every "a value arrives later for this identity" channel routes through here
 * instead of owning its own subscriber set. Browser-only in practice (the request-scoped
 * server never re-settles an id within one render).
 */
export function watch(id: string, cb: (live: unknown) => void): () => void {
	const reg = registry();
	let set = reg.watchers.get(id);
	if (set === undefined) reg.watchers.set(id, (set = new Set()));
	set.add(cb);
	return () => {
		const s = reg.watchers.get(id);
		if (s === undefined) return;
		s.delete(cb);
		if (s.size === 0) reg.watchers.delete(id);
	};
}

/**
 * Notify watchers that fresh data settled for `id`. Called by resolve's live-merge path AND
 * directly by subsystems that push a value in (a region frame landing, a streamed promise
 * resolving) — those pass the settled value; resolve's path passes the merged live instance.
 * A throwing watcher never blocks the others.
 */
export function notify(id: string, live: unknown): void {
	// During a batch (phase B), buffer instead of firing — a later id overwrites an earlier one,
	// so each watched id notifies at most once, with its FINAL value, after the whole batch decodes.
	if (batch_depth > 0) {
		(batch_pending ??= new Map()).set(id, live);
		return;
	}
	notify_now(id, live);
}

function notify_now(id: string, live: unknown): void {
	const set = registry().watchers.get(id);
	if (set === undefined) return;
	for (const cb of [...set]) {
		try {
			cb(live);
		} catch {
			/* one watcher's throw must not starve the rest */
		}
	}
}

// ── batch (phase B): resolve a bag of refs as ONE transaction — decode everything, THEN notify.
// Without this, resolving refs one-by-one lets a watcher fire between two merges and observe a
// torn cross-ref state (cart merged, user not yet). Reentrant via a depth counter.
let batch_depth = 0;
let batch_pending: Map<string, unknown> | null = null;

/**
 * Run `fn` with watch notifications BUFFERED, flushing them once when the outermost batch exits.
 * Wrap any operation that resolves several refs at once (a context parse, a props decode, a nav's
 * ref bag) so cross-ref invariants hold before any watcher reacts. Returns `fn`'s result.
 */
export function batch<T>(fn: () => T): T {
	batch_depth++;
	try {
		return fn();
	} finally {
		batch_depth--;
		if (batch_depth === 0) {
			const pending = batch_pending;
			batch_pending = null;
			if (pending !== undefined && pending !== null) {
				for (const [id, live] of pending) notify_now(id, live);
			}
		}
	}
}

/** Resolve a bag of refs as one transaction (sugar over {@link batch}). */
export function resolve_batch(refs: readonly Ref[], scope: boolean | Scope): unknown[] {
	return batch(() => refs.map((r) => resolve(r, scope)));
}

/** How many watchers are registered for `id` — lets a subsystem that owns lifecycle around a
 *  hub id (fetch dedupe, eviction TTL) make refcount decisions without a parallel subscriber set. */
export function watcher_count(id: string): number {
	return registry().watchers.get(id)?.size ?? 0;
}

/** Devalue custom-type name for hub refs on the wire (the ONE key every seam will converge on). */
export const REF_WIRE_KEY = 'OgygiaRef';

/** Devalue reducer for a seam. `only` deliberately restricts which families may cross there. */
export function ref_reducer(only?: ReadonlySet<string>): (value: unknown) => Ref | undefined {
	return (value) => mint(value, only);
}

/** Devalue reviver for a seam. Browser passes `remember: true`; the server must pass `false`. */
export function ref_reviver(remember: boolean): (ref: Ref) => unknown {
	return (ref) => resolve(ref, remember);
}
