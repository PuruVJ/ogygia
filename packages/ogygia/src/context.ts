import { getContext, setContext } from 'svelte';
import { BROWSER } from 'esm-env';
import { getRequestEvent } from 'virtual:ogygia/request-event';
import { csr_true_routes, error_csr_true_routes, root_layout_csr_true } from 'virtual:ogygia/route-csr';
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
export function documentIsCsrTrue(error_render = false): boolean {
	if (BROWSER) return kit_hydrates_page();
	try {
		const event = getRequestEvent() as { route?: { id?: string | null } };
		// An ERROR render (a 404 / 500 page) is Kit's layout-branch decision, not the page's: the
		// caller (Region) passes what it reads off Kit's page state, and the handle passes the
		// response status — the same map answers both.
		return error_render
			? error_route_is_csr_true(event.route?.id)
			: route_is_csr_true(event.route?.id);
	} catch {
		return false; // off-request (prerender helper, etc.) → not a Kit-hydrated document
	}
}

/**
 * PUBLIC: is the current page an ogygia page (csr=false), as opposed to a csr=true page Kit hydrates
 * whole? The inverse of {@link documentIsCsrTrue}, so it answers on BOTH legs with no requestEvent
 * handling on the caller's side — server reads the request's route against the build-time csr set,
 * client reads Kit's bootstrap. Meant for shared code (a store, a helper) that must branch on which
 * world it runs in. Off-request on the server (a module init, a prerender helper with no page) there
 * is no document to speak of, so it returns `false`.
 */
export function isOgygiaPage(): boolean {
	return !documentIsCsrTrue();
}

/** The same fact from a route id in hand (the handle has the event): is this route's leaf page
 *  csr=true? A build-time answer — never a scan of the rendered document. */
export function route_is_csr_true(id: string | null | undefined): boolean {
	return id != null && csr_true_routes.has(normalize_route_id(id));
}

/** The ERROR-page twin: does Kit hydrate this route's `+error.svelte`? Kit renders an error page
 *  with the layout branch only (the page node — and its `csr = false` — is dropped), so this reads
 *  the layouts' answer; a routeless response (no route matched) is the root layout's. */
export function error_route_is_csr_true(id: string | null | undefined): boolean {
	if (id == null) return root_layout_csr_true;
	return error_csr_true_routes.has(normalize_route_id(id));
}

/** Per-request: only one `data-ogygia-runtime` script should be emitted (the first island). */
const runtime_claimed = new WeakMap<object, true>();

/** Per-request: stylesheet hrefs already linked for held regions rendered in this SSR pass. */
const region_css_claimed = new WeakMap<object, Set<string>>();

/** Per-request: island entries already stamped `<meta name="ogygia-kit-island">` in this pass. */
const kit_island_claimed = new WeakMap<object, Set<string>>();

/**
 * Claim an INLINE-rendered island's entry for this SSR request — true the first time, so the page
 * stamps one `<meta name="ogygia-kit-island" content="<entry>">` per rendered island, however many
 * instances render. The client wrapper's lazy component module reads the stamp before Kit hydrates
 * (emit.ts `lazy_entry_source`): a stamped island's entry is imported, an unstamped one costs
 * nothing. Client / no-request → false (nothing to stamp there).
 */
export function claim_kit_island(entry: string): boolean {
	if (!entry) return false;
	try {
		const event = getRequestEvent() as object;
		let seen = kit_island_claimed.get(event);
		if (!seen) kit_island_claimed.set(event, (seen = new Set()));
		if (seen.has(entry)) return false;
		seen.add(entry);
		return true;
	} catch {
		return false;
	}
}

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
