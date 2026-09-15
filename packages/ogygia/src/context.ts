import { getContext, setContext } from 'svelte';
import { BROWSER } from 'esm-env';
import { getRequestEvent } from 'virtual:ogygia/request-event';
import { csr_true_routes } from 'virtual:ogygia/route-csr';
import { kit_hydrates_page } from './runtime/kit-boot.js';

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

// Context key marking "this subtree is INSIDE A LAKE" (a `wake: 'none'` region). Same `Symbol.for`
// rule as NESTED_KEY. A lake is server HTML that Kit's hydration never enters — on a csr=true page
// the lake wrapper ADOPTS its element as opaque DOM (Region.svelte, lake branch) — so the regions
// authored inside a lake belong to ogygia's world on EVERY page: the server must emit their real
// `<ogygia-region>` even when the document is Kit-hydrated. Region reads this to switch its csr=true
// inline degradation off; the runtime mirrors it with `inside_frozen` (region-attrs.ts).
const LAKE_KEY = Symbol.for('ogygia.lake-subtree');

/** Mark the current subtree as a lake's inside (LakeBoundary). */
export function setInLake(): void {
	setContext(LAKE_KEY, true);
}

/** True when an ancestor lake boundary marked the subtree. */
export function isInLake(): boolean {
	return getContext(LAKE_KEY) === true;
}

// Context key marking "this server island is rendering INLINE in the page pass" — it sits inside a
// `wake` island, where `render: 'deferred'` is ignored (the nested rule) and its component renders
// as a plain child instead of on the endpoint. `keepFallback()` reads it: thrown here its signal
// would not reach the handle's catch but Kit's error page (a whole site went 500 on a footer hole
// placed inside an island). Same `Symbol.for` discipline as the keys above.
const HOLE_INLINE_KEY = Symbol.for('ogygia.hole-inline');

/** Region.svelte marks the subtree of a server island it is rendering inline (nested). */
export function setHoleInline(): void {
	setContext(HOLE_INLINE_KEY, true);
}

/** Is this render a server island's component rendering INLINE (nested in an island)? */
export function isHoleInline(): boolean {
	return getContext(HOLE_INLINE_KEY) === true;
}

/** Kit `route.id`, GROUP segments (`(app)`) stripped — mirrors the compiler's `normalize_route_id`
 *  so both sides match whether or not Kit keeps groups in `route.id`. Root → `/`. */
function normalize_route_id(id: string): string {
	const segs = id
		.split('/')
		.filter(Boolean)
		.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
	return '/' + segs.join('/');
}

/**
 * Does Kit hydrate THIS WHOLE DOCUMENT? The leaf page's effective csr is the single fact that decides
 * it, so a `<Region>` reads it directly — no per-host context cascade. When true, every island (a
 * csr=true page's own, a csr=false layout's chrome, a shared component's) degrades to a plain inline
 * component that Kit hydrates. Server: the route is in the build-time csr=true set. Client: Kit
 * shipped its bootstrap. Same fact on both legs → the inline/island choice can never desync at
 * hydrate. (Replaces the old `CSR_TRUE_KEY` marker + `csr=false` reset, which only re-derived this
 * number indirectly through the context cascade.)
 */
export function documentIsCsrTrue(): boolean {
	if (BROWSER) return kit_hydrates_page();
	try {
		const event = getRequestEvent() as { route?: { id?: string | null } };
		return route_is_csr_true(event.route?.id);
	} catch {
		return false; // off-request (prerender helper, etc.) → not a Kit-hydrated document
	}
}

/** The same fact from a route id in hand (the handle has the event): is this route's leaf page
 *  csr=true? A build-time answer — never a scan of the rendered document. */
export function route_is_csr_true(id: string | null | undefined): boolean {
	return id != null && csr_true_routes.has(normalize_route_id(id));
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
