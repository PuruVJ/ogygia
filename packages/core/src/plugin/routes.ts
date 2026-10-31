/**
 * ROUTE OPTIONS — a plugin's per-route boolean (`export const freeze = false` in a `+page.ts`), read
 * the way Kit reads `csr`: the deepest declaration on the page's option-file chain wins. A plugin
 * names its options once (`compile.routeOptions`); the compiler strips them from the route files
 * before Kit sees them (Kit rejects unknown page exports) and bakes each page's declared value.
 *
 * Two worlds answer, in the order dispatch itself resolves a request:
 * 1. A mounted programmatic `routes()` table that CLAIMS the pathname (it answers inside the
 *    handle, ahead of any file route): its declared page > layout > table value; claimed but
 *    undeclared = `undefined`.
 * 2. A Kit page route: its compile-time cascaded value (`undefined` when nothing declares it).
 * Anything else (an endpoint, a request no route claimed) answers `undefined`: the plugin's own
 * default applies.
 *
 * One global slot: dist entries and plugin packages must share the registry.
 */

/** Per matcher: `undefined` = not mine (ask the next one, then the file world) · `null` = mine,
 *  but nothing declared this option · `boolean` = mine, declared. */
export type RouteOptionVerdict = boolean | null | undefined;
export type RouteOptionMatcher = (pathname: string, option: string) => RouteOptionVerdict;

interface RoutesSlot {
	routers: Map<string, RouteOptionMatcher>;
	/** route id (group-stripped) → option → declared value, for every Kit page route */
	pages: Map<string, Record<string, boolean>>;
}
const slot: RoutesSlot = ((globalThis as Record<symbol, RoutesSlot | undefined>)[
	Symbol.for('ogygia.route-options.v1')
] ??= {
	routers: new Map(),
	pages: new Map()
});

/** A `routes()` table joins (keyed: dev re-evaluates hooks.server.ts and calls `routes()` again; a
 *  matcher with the same key REPLACES its stale twin instead of shadowing it). */
export function register_route_options(key: string, matcher: RouteOptionMatcher): void {
	slot.routers.delete(key);
	slot.routers.set(key, matcher);
}

/** Core only (hooks.ts): the Kit pages' declared values, baked by the compiler. */
export function set_page_route_options(pages: Record<string, Record<string, boolean>>): void {
	slot.pages = new Map(Object.entries(pages));
}

/** Tests only. */
export function clear_route_options(): void {
	slot.routers.clear();
	slot.pages.clear();
}

/** Kit's `(group)` segments dropped from a `route.id` (the compiler keys pages the same way). */
function strip_route_groups(id: string): string {
	const segs = id
		.split('/')
		.filter(Boolean)
		.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
	return '/' + segs.join('/');
}

/** This request's declared value for `option`, or `undefined` (use the plugin's default). A null
 *  `routeId` is never normalized to `/` — that would be a different route. */
export function route_option(
	option: string,
	route_id: string | null | undefined,
	pathname: string
): boolean | undefined {
	for (const matcher of slot.routers.values()) {
		const v = matcher(pathname, option);
		if (v !== undefined) return v ?? undefined;
	}
	if (route_id == null) return undefined;
	return slot.pages.get(strip_route_groups(route_id))?.[option];
}
