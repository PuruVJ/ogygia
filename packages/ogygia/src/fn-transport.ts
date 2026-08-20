/**
 * Transportable functions — the hub's FN kind (the runtime half of `import.meta.og.$`).
 *
 * A closure can never serialize — there is no runtime API for a function's captured scope.
 * What CAN cross is a QRL-style handle: WHERE the code lives (a build tag) plus WHAT it
 * closed over (bound captures, as data). The compiler half (a later phase) hoists a marked
 * closure to a generated module at build time:
 *
 * ```ts
 * // source:                         setContext('fmt', import.meta.og.$((n) => `${n * rate}`));
 * // generated module (tagged):      export const $0 = (rate) => (n) => `${n * rate}`;
 * //                                 __register_fn('routes/+layout#$0', $0);
 * // call site rewrites to:          setContext('fmt', fn_handle('routes/+layout#$0', [rate]));
 * ```
 *
 * This module is the machinery both halves share: the factory registry, the branded live
 * handle (`fn_handle` — callable on the SERVER leg too, where the factory module is loaded),
 * and the kind. Decode = look the tag up, `factory(...bound)` → the live closure. Captures
 * are themselves refs-or-data, so a bound capture may be a store/wire instance that reunites.
 *
 * IDENTITY: functions are deliberately NEVER memoized by the hub (`resolve` only remembers
 * objects). Each consumer rebinds its own closure — stateless until called, exactly like
 * snippets. Anything stateful a function closes over should be a store/wire capture, which
 * DOES reunite; then every rebound copy sees the same live state.
 */

import { register_kind, mint, resolve, type Ref } from './ref.js';

/** Brand on a live handle: carries `{ t, d }` so encode is a field read, not an analysis. */
const FN_BRAND = Symbol.for('ogygia.fn');

interface FnRegistry {
	/** tag → factory `(…bound) => fn`, filled by build-generated `__register_fn` calls. */
	factories: Map<string, (...bound: unknown[]) => unknown>;
}

const REGISTRY_KEY = Symbol.for('ogygia.fns');

function fn_registry(): FnRegistry {
	const g = globalThis as Record<symbol, unknown>;
	return ((g[REGISTRY_KEY] as FnRegistry | undefined) ??= { factories: new Map() });
}

/** Register a hoisted-function factory under its build tag (module path + export name).
 *  Called by the generated module; runs wherever that chunk loads (server AND island bundles). */
export function __register_fn(tag: string, factory: unknown): void {
	register_fn_kind(); // pull-registration: the generated module loading IS the moment the kind is needed
	if (typeof factory !== 'function') return;
	fn_registry().factories.set(tag, factory as (...bound: unknown[]) => unknown);
}

/** Is this a transportable (og.$-branded) function? The drop-in setContext bridges these —
 *  the "functions never cross" law applies to BARE functions only. */
export function is_branded_fn(value: unknown): boolean {
	return typeof value === 'function' && (value as BrandedFn)[FN_BRAND] !== undefined;
}

type BrandedFn = ((...args: unknown[]) => unknown) & {
	[FN_BRAND]?: { t: string; d: unknown[]; s?: string };
};

/**
 * The call-site rewrite target: build the LIVE function for this side (the factory's module is
 * imported right there, so it is always registered) and brand it with its travel handle. The
 * host renders with a real function; if it crosses a boundary, the brand is what travels.
 */
export function fn_handle(tag: string, bound: unknown[]): (...args: unknown[]) => unknown {
	register_fn_kind();
	const factory = fn_registry().factories.get(tag);
	if (factory === undefined) {
		throw new Error(
			`[ogygia] fn_handle("${tag}"): its factory is not registered on this side. The generated ` +
				`module must be imported as a VALUE at the call site (the compiler emits this import).`
		);
	}
	const live = factory(...bound) as BrandedFn;
	if (typeof live !== 'function') {
		throw new Error(`[ogygia] fn factory "${tag}" did not return a function.`);
	}
	// The factory is SELF-CONTAINED by construction (og-dollar's capture law), so its source is
	// shippable: it rides the brand as the registry-miss fallback — a client bundle that never
	// loaded the fn manifest can still rebuild the function from the payload itself.
	live[FN_BRAND] = { t: tag, d: bound, s: factory.toString() };
	return live;
}

/** The hub kind: a branded hoisted function. Bare functions are NEVER claimed (the snippet kind
 *  owns SSR-freezable snippets; an unmarked function at a boundary must keep failing loudly). */
export function register_fn_kind(): void {
	register_kind({
		k: 'fn',
		match(value) {
			return typeof value === 'function' && (value as BrandedFn)[FN_BRAND] !== undefined;
		},
		encode(value) {
			const brand = (value as BrandedFn)[FN_BRAND] as { t: string; d: unknown[]; s?: string };
			return { t: brand.t, d: { b: brand.d, ...(brand.s ? { s: brand.s } : {}) } };
		},
		decode(ref: Ref) {
			const payload = (ref.d ?? {}) as { b?: unknown[]; s?: string };
			let factory = fn_registry().factories.get(ref.t as string);
			if (factory === undefined) {
				// The page-inline manifest (PROD, CSP-clean): the handle emitted real function
				// values into globalThis.__OG_FNM before hydration — no eval involved.
				const fnm = (globalThis as { __OG_FNM?: Record<string, unknown> }).__OG_FNM;
				const from_page = fnm?.[ref.t as string];
				if (typeof from_page === 'function') {
					factory = from_page as (...bound: unknown[]) => unknown;
					fn_registry().factories.set(ref.t as string, factory);
				}
			}
			if (factory === undefined && typeof payload.s === 'string') {
				// Registry miss + the payload carries the factory source (self-contained by the
				// capture law) → rebuild from source. Indirect eval; a strict-CSP app (no
				// 'unsafe-eval') should ship the fn manifest so this path never runs.
				factory = (0, eval)(`(${payload.s})`) as (...bound: unknown[]) => unknown;
				fn_registry().factories.set(ref.t as string, factory); // once per tag
			}
			if (factory === undefined) {
				throw new Error(
					`[ogygia] cannot revive fn "${ref.t}": its factory is not loaded on this side and the ` +
						`payload carries no source. The island must import the generated module as a VALUE so ` +
						`\`__register_fn\` runs in its bundle (or the fn manifest must be in the runtime).`
				);
			}
			const bound = Array.isArray(payload.b) ? payload.b : [];
			const live = factory(...bound) as BrandedFn;
			// re-brand (source included): a revived fn can cross a FURTHER boundary
			live[FN_BRAND] = { t: ref.t as string, d: bound, ...(payload.s ? { s: payload.s } : {}) };
			return live;
		}
	});
}
const FN_ONLY = new Set(['fn']);

/** Devalue reducer (legacy-shaped wrapper, mirrors the other kinds). */
export function reduce_fn(value: unknown): { t: string; i: string; d: unknown } | undefined {
	register_fn_kind();
	const ref = mint(value, FN_ONLY);
	if (ref === undefined) return undefined;
	return { t: ref.t as string, i: ref.i, d: ref.d };
}

/** Devalue reviver. Functions never memoize; `remember` rides through for capture resolution. */
export function revive_fn(payload: { t: string; i: string; d: unknown }, remember: boolean): unknown {
	register_fn_kind();
	return resolve({ k: 'fn', i: payload.i, t: payload.t, d: payload.d }, remember);
}

/**
 * The `import.meta.og.$` rewrite target: register the hoisted factory (pull-registration —
 * the call site IS the moment the code exists) and return the LIVE bound function, branded
 * with its travel handle. One expression, no import-time side effects.
 */
export function __og_$(tag: string, bound: unknown[], factory: (...b: unknown[]) => unknown): (...args: unknown[]) => unknown {
	__register_fn(tag, factory);
	return fn_handle(tag, bound);
}
