import { getContext, setContext } from 'svelte';
import { getRequestEvent } from 'virtual:ogygia/request-event';

// Context key marking "this subtree is already inside a hydrated island". Nested island wrappers
// read it and degrade to a plain inline component so an island-within-an-island hydrates exactly
// once, together with its parent.
//
// KEY IDENTITY (CTX-KEY): must be `Symbol.for` (global registry), NOT `createContext`'s per-call
// `Symbol()`. The runtime bundle (which mounts NestedProvider → setNested) and each island-entry
// bundle (which renders a lake region → isNested) are SEPARATE Vite entry graphs; `context.ts` is
// duplicated across them on the client, so a per-module `Symbol()` mints a different key in each —
// setNested and isNested then miss each other and a lake renders no `<ogygia-region hydrate="none">`,
// so the lift/restore drops it. SSR bundles once, so the key matches there — hence it broke ONLY
// after client hydration. A global `Symbol.for` is one key across every graph.
const NESTED_KEY = Symbol.for('ogygia.nested-island');

/**
 * Mark the current subtree's hydration state. `true` = inside a hydrated island (nested islands
 * degrade). `false` = a LAKE resets its subtree to "dead", so an island inside the lake self-
 * hydrates again (the nearest-boundary rule — DESIGN.md).
 */
export function setNested(value = true): void {
	setContext(NESTED_KEY, value);
}

/**
 * True when an ancestor island wrapper already marked the subtree. `getContext` returns `undefined`
 * when no ancestor set it (a top-level island) — that absence is exactly "not nested".
 */
export function isNested(): boolean {
	return getContext(NESTED_KEY) === true;
}

// Context key marking "this subtree is on a csr=true page". A csr=true route host is Kit-hydrated,
// so a `<Region>` there should render its component INLINE in the Kit tree (Kit hydrates it) rather
// than emit an `<ogygia-region>` + runtime — the same "render as a plain component" degradation the
// nested rule already does. The transform sets it: it injects a bare `setContext` into every
// csr=true route host (see compiler/transform.ts `inject_csr_context` — NO ogygia import, so a
// region-less csr=true page still ships zero ogygia). Because the host renders on BOTH the SSR and
// the Kit-client leg, the flag is identical on both → the island/inline choice can never desync at
// hydrate. `Symbol.for` for the same cross-graph reason as NESTED_KEY.
//
// KEY STRING (CSR-KEY): the literal below MUST match the string the transform bakes into the
// injected `Symbol.for(...)` call. Change one, change both; the region-mixed e2e locks it.
const CSR_TRUE_KEY = Symbol.for('ogygia.csr-true');

/** True when rendered inside a csr=true route host (Kit owns hydration — degrade islands to plain). */
export function isCsrTrue(): boolean {
	return getContext(CSR_TRUE_KEY) === true;
}

/** Per-request: only one `data-ogygia-runtime` script should be emitted (the first island). */
const runtime_claimed = new WeakMap<object, true>();

/** Per-request: stylesheet hrefs already linked for held regions rendered in this SSR pass. */
const region_css_claimed = new WeakMap<object, Set<string>>();

/**
 * Claim stylesheet hrefs for this SSR request, returning only the not-yet-claimed ones. A held
 * region's component is server-picked, so its CSS is on no page stylesheet (Kit links CSS from the
 * route's STATIC import graph — it never reads the rendered page). The region wrapper links it from
 * the render pass instead, via `<svelte:head>`; claiming here dedupes so five `Feature` blocks on a
 * page link their shared sheet once. Client / no-request → [] (SSR already linked them).
 */
export function claim_region_css(hrefs: string[]): string[] {
	if (!hrefs.length) return [];
	try {
		const event = getRequestEvent() as object;
		let seen = region_css_claimed.get(event);
		if (!seen) region_css_claimed.set(event, (seen = new Set()));
		const fresh = hrefs.filter((h) => !seen.has(h));
		for (const h of fresh) seen.add(h);
		return fresh;
	} catch {
		return [];
	}
}

/**
 * Claim the single runtime-script slot for this SSR request. An island/server placement emits the
 * runtime bootstrap so it hydrates even with the router off; when the router is on, the handle
 * injects the same script into `<head>` (presence-checked) on pages that have no island to emit it.
 * Client / no-request → false (SSR already emitted).
 */
export function claimRuntimeEmit(): boolean {
	try {
		const event = getRequestEvent() as object;
		if (runtime_claimed.has(event)) return false;
		runtime_claimed.set(event, true);
		return true;
	} catch {
		return false;
	}
}
