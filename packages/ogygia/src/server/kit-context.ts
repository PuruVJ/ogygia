/**
 * Kit's request context for ogygia's OWN server render roots.
 *
 * Kit's server `$app/state` answers `page.*` from `getContext('__request__').page` — a Svelte
 * context Kit's page render sets on ITS root. Every `svelte/server` `render()` ogygia starts is a
 * fresh root with no such context: the routeless document (`document()`), the inline island render
 * (`region.ts`), the deferred-region endpoint, snippet bodies. A component reading `page.data`
 * during SSR under any of them crashed with "reading 'page' of undefined". Every such root now
 * passes `kit_render_context()`, which rebuilds Kit's shape from the per-request page snapshot
 * (Region.svelte records it; the handle keeps it in the request bag) or, absent that, from the
 * live request via the reader hooks.ts installs.
 *
 * Isomorphic and dependency-free by design: `region.ts` is in the client graph, so nothing here may
 * import Kit's server internals. The reader rides ONE `globalThis` + `Symbol.for` slot — the
 * PAGE-STATE-SINGLETON law (dist entries can double-evaluate a module).
 */

export const KIT_REQUEST_CONTEXT = '__request__';

/** Kit's `props.page` shape (what `$app/state`'s server getters read). */
export interface KitPage {
	url: URL | undefined;
	params: Record<string, string | undefined>;
	route: { id: string | null };
	status: number;
	data: unknown;
	form: unknown;
	error: unknown;
	state: Record<string, unknown>;
}

type Reader = () => KitPage | null;
interface Slots {
	reader: Reader | null;
}

const SLOT = Symbol.for('ogygia.kit-context');
const slots: Slots = ((globalThis as unknown as Record<symbol, Slots | undefined>)[SLOT] ??= {
	reader: null
});

/** hooks.ts installs the request-scoped reader (page snapshot + live event). */
export function set_kit_page_reader(fn: Reader | null): void {
	slots.reader = fn;
}

/** A page no component can crash on: what a render outside any request sees (tests, tools). */
export function empty_kit_page(): KitPage {
	return {
		url: undefined,
		params: {},
		route: { id: null },
		status: 200,
		data: {},
		form: null,
		error: null,
		state: {}
	};
}

/** The `context` option for a `svelte/server` `render()` ogygia starts. An explicit `page` (the
 *  document root, built from the router's seed) wins; else the request reader; else empty. */
export function kit_render_context(page?: KitPage): Map<string, unknown> {
	const resolved = page ?? slots.reader?.() ?? empty_kit_page();
	return new Map([[KIT_REQUEST_CONTEXT, { page: resolved }]]);
}
