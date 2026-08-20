/**
 * Transportable stores — the hub's STORE kind.
 *
 * A Svelte store is a live object (closure + methods), so devalue rejects it and a
 * `setContext('cart', store)` silently died at the island boundary. This kind lets a
 * subscribe-shaped value cross the same way `[import.meta.og.wire]` classes do: the CURRENT
 * VALUE travels as data, the CODE comes from a module on the other side, and hub identity
 * makes it live — every encode of one store mints ONE id, and the browser resolves by id,
 * so five islands reading the same context key share one client store. `set` in island A
 * repaints `$store` in island B.
 *
 * Two tiers:
 *  - REGISTERED FACTORY (`__register_store_factory(tag, factory)`): decode calls
 *    `factory(seed)` from the registered module, so custom methods (`add`, `reset`,
 *    `useLocalStorage`, …) are REBUILT, not serialized. A store is branded with its factory
 *    tag via `mark_store` (hand-written today, compiler-emitted later).
 *  - GENERIC (`svelte:writable`): any unbranded subscribe-shaped value. Decode is a plain
 *    `writable(seed)` — value + set/update/subscribe survive; bespoke methods do not (the
 *    boundary classifier warns, naming them).
 *
 * Identity, reunification, per-request server isolation: the hub's (see ref.ts).
 */

import { get, writable, derived } from 'svelte/store';
import { wire } from './live-transport.js';
import { register_kind, mint, resolve, type Ref } from './ref.js';

/** Brand on an `og_derived` store: the RECIPE (sources + formula) it was made from. */
const DERIVED_BRAND = Symbol.for('ogygia.derived');

/** Devalue custom-type name for store payloads on the wire. */
export const STORE_WIRE_KEY = 'OgygiaW';

/** Generic tag: decode with a bare `writable(seed)`. */
const GENERIC_TAG = 'svelte:writable';

/** Brand carrying a factory tag on a store object (non-enumerable, set by `mark_store`). */
const STORE_TAG = Symbol.for('ogygia.store.tag');

interface StoreLike {
	subscribe: (run: (value: unknown) => void) => unknown;
	set?: (value: unknown) => void;
	update?: (fn: (value: unknown) => unknown) => void;
	[STORE_TAG]?: string;
}

/** Legacy wire shape (`t` factory tag, `i` id, `d` current value) — a hub Ref minus its kind. */
interface StorePayload {
	t: string;
	i: string;
	d: unknown;
}

interface StoreRegistry {
	/** tag → factory, filled by `__register_store_factory` (compiler-emitted or manual). */
	factories: Map<string, (seed: unknown) => object>;
}

const REGISTRY_KEY = Symbol.for('ogygia.stores');

function store_registry(): StoreRegistry {
	const g = globalThis as Record<symbol, unknown>;
	return ((g[REGISTRY_KEY] as StoreRegistry | undefined) ??= { factories: new Map() });
}

/** Subscribe-shaped, NOT a `[ogygia.wire]` class instance (wire kind), and NOT an `og_derived`
 *  (the derived kind carries its recipe — the store kind would freeze it to a seed). */
export function is_store(value: unknown): value is StoreLike {
	if (value === null || typeof value !== 'object') return false;
	if (typeof (value as StoreLike).subscribe !== 'function') return false;
	if ((value as Record<symbol, unknown>)[DERIVED_BRAND] !== undefined) return false;
	const cls = (value as { constructor?: unknown }).constructor;
	if (typeof cls === 'function' && (cls as unknown as Record<symbol, unknown>)[wire]) return false;
	return true;
}

/** A readable with no way back in — seeding it loses the derivation (classifier warns). */
export function is_derived_like(value: StoreLike): boolean {
	return typeof value.set !== 'function' && typeof value.update !== 'function';
}

/**
 * Register a store factory under a stable tag (root-relative module path + export name, same
 * scheme as transportable classes). Decode calls `factory(seed)`, so the rebuilt store keeps
 * every method the factory grafts on. Over-registration is harmless.
 */
export function __register_store_factory(tag: string, factory: unknown): void {
	if (typeof factory !== 'function') return;
	store_registry().factories.set(tag, factory as (seed: unknown) => object);
}

/**
 * Brand a store with its factory tag so encode ships the tag instead of the generic one.
 * Returns the store (chainable at a return site). Hand-written today; the auto-wire compiler
 * pass will emit this into provably store-returning factories.
 */
export function mark_store<T extends object>(store: T, tag: string): T {
	Object.defineProperty(store, STORE_TAG, { value: tag, enumerable: false });
	return store;
}

/** The hub kind: subscribe-shaped values. The moment of crossing is the value snapshot. */
export function register_store_kind(): void {
	register_kind({
	k: 'store',
	match: is_store,
	encode(value) {
		return { t: (value as StoreLike)[STORE_TAG] ?? GENERIC_TAG, d: get(value as never) };
	},
	decode(ref) {
		const t = ref.t ?? GENERIC_TAG;
		const factory = t === GENERIC_TAG ? undefined : store_registry().factories.get(t);
		if (t !== GENERIC_TAG && factory === undefined) {
			// GRACEFUL FLOOR: a branded store whose factory module isn't in this bundle degrades to
			// the generic tier — the VALUE still crosses and set/update/subscribe work; only the
			// factory's grafted methods are missing. This keeps auto-branding strictly additive
			// (before branding, this store crossed generic anyway). Warn so the fix is one import.
			if (typeof console !== 'undefined') {
				console.warn(
					`[ogygia] store "${t}": factory not loaded in this bundle — degraded to a plain writable ` +
						`(custom methods unavailable). Import the factory's module in the island (or its graph) ` +
						`so \`__register_store_factory\` runs there.`
				);
			}
			return writable(ref.d) as object;
		}
		return factory ? factory(ref.d) : (writable(ref.d) as object);
	}
});
}

const STORE_ONLY = new Set(['store']);

/**
 * Devalue reducer: encode a store, or return undefined to fall through. Reads the store's
 * CURRENT value with `get()` — the moment of crossing is the snapshot. Same instance → same
 * wire id (hub-memoized), which is what lets the client reunite every copy into one live store.
 */
export function reduce_store(value: unknown): StorePayload | undefined {
	register_store_kind();
	const ref = mint(value, STORE_ONLY);
	if (ref === undefined) return undefined;
	return { t: ref.t as string, i: ref.i, d: ref.d };
}

/**
 * Devalue reviver: rebuild a live store via the hub. `remember: true` (browser) memoizes by
 * wire id — every island decoding this handle gets the SAME store, which is the liveness
 * mechanism. `remember: false` (server) always builds fresh: per-request isolation.
 */
export function revive_store(payload: StorePayload, remember: boolean): unknown {
	register_store_kind();
	const ref: Ref = { k: 'store', i: payload.i, t: payload.t, d: payload.d };
	return resolve(ref, remember);
}

/**
 * The `import.meta.og.store` rewrite target: register the factory under its build tag (module
 * load IS the moment decode needs the registry filled — an island imports the factory module,
 * registration rides that import) and return a wrapper whose every product is BRANDED with the
 * tag, so encode ships the tag instead of the generic one and decode rebuilds THROUGH the
 * factory — custom methods survive the wire.
 */
export function __og_store<F extends (...args: never[]) => object>(tag: string, factory: F): F {
	// decode side: factory(seed), branded so a revived store can cross a FURTHER boundary
	__register_store_factory(tag, (seed: unknown) => mark_store((factory as (...a: unknown[]) => object)(seed), tag));
	// encode side: every product of the wrapped factory carries its passport
	return ((...args: never[]) => mark_store(factory(...args), tag)) as F;
}

// ─────────────────────────────────── og_derived: a derived that RESUMES ───────────────────────────

type AnyStore = { subscribe: (run: (v: never) => void) => unknown };
type DerivedRecipe = { s: AnyStore[]; f: (...vals: never[]) => unknown; single: boolean };

/**
 * A `derived` that CROSSES boundaries ALIVE — resumability for the reactive graph.
 *
 * Svelte's `derived` is a live computation: sources + a formula. The value can serialize; the
 * computation can't — so a plain derived crosses as a FROZEN seed (the classifier warns). This
 * primitive remembers its RECIPE, and the recipe is made of exactly the two things the seam
 * already carries: sources are STORES (they reunify to one live instance per island page) and
 * the formula is a FUNCTION (mark it with `import.meta.og.$` so it travels as a fn ref).
 *
 * ```ts
 * const doubled = og_derived(tally, import.meta.og.$((n) => n * 2));
 * ```
 *
 * Locally it IS `svelte/store`'s derived — same laziness, same semantics. At a boundary the
 * derived kind ships `{ sources, formula, seed }`; the island decodes by re-deriving against
 * the REUNIFIED sources with the REBOUND formula: bump the source in any island and every
 * island's derived follows. The seed rides along only for exactness of the first paint.
 *
 * An UNMARKED formula still works same-tree, but the derived then can't cross (the fn ref
 * can't be built) — the boundary explains this at the seam rather than freezing silently.
 */
export function og_derived<T>(
	sources: AnyStore | AnyStore[],
	fn: (...vals: never[]) => T,
	initial?: T
): { subscribe: (run: (v: T) => void) => () => void } {
	const single = !Array.isArray(sources);
	const store = derived(sources as never, fn as never, initial as never) as unknown as {
		subscribe: (run: (v: T) => void) => () => void;
	};
	const recipe: DerivedRecipe = { s: single ? [sources as AnyStore] : (sources as AnyStore[]), f: fn, single };
	Object.defineProperty(store, DERIVED_BRAND, { value: recipe, enumerable: false });
	return store;
}

/** The hub kind: an `og_derived` recipe. Sources and formula are shipped as NESTED refs (devalue
 *  recursion runs the reducer over `d`'s contents), so by decode time they are already LIVE —
 *  sources reunified, formula rebound — and re-deriving is one call. */
export function register_derived_kind(): void {
	register_kind({
		k: 'derived',
		match(value) {
			return (
				value !== null &&
				typeof value === 'object' &&
				(value as Record<symbol, unknown>)[DERIVED_BRAND] !== undefined
			);
		},
		encode(value) {
			const r = (value as unknown as Record<symbol, unknown>)[DERIVED_BRAND] as DerivedRecipe;
			// The recipe (sources + formula + seed) is the whole payload; devalue's recursion over `d`
			// mints the nested source/fn refs so they cross live. (No dep-edge emission — the hub's
			// dependency graph was removed as dead; nothing consumed it.)
			return { d: { s: r.s, f: r.f, single: r.single, seed: get(value as never) } };
		},
		decode(ref) {
			const d = ref.d as { s: AnyStore[]; f: (...vals: never[]) => unknown; single: boolean; seed: unknown };
			if (typeof d.f !== 'function') {
				throw new Error(
					`[ogygia] cannot resume og_derived: its formula did not cross — mark it with ` +
						`import.meta.og.$ at the og_derived call site so it travels as a fn ref.`
				);
			}
			return og_derived((d.single ? d.s[0] : d.s) as never, d.f, d.seed as never);
		}
	});
}
