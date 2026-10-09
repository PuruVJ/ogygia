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
/** Kit's `$app/stores` server side reads `getContext('__svelte__')` — `{ page, navigating, updated }`
 *  stores Kit's page render sets on ITS root (`render.js`). Same gap as `__request__`: a component
 *  using the (deprecated, still everywhere) `$page` store crashed under every ogygia render root. */
export const KIT_STORES_CONTEXT = '__svelte__';

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
type EventReader = () => unknown | null;
/** THE PAGE OF A RENDER, as a render root uses it (server/render-page.ts behind it). */
interface RenderPagePort {
	/** Before the root renders: its page ready for the reader. `reads_data` — `true`: this render
	 *  reads `page.data`; `false`: it does not; `null`: unknown here (the request's kind decides). */
	ready(reads_data: boolean | null): Promise<void> | void;
	/** After it rendered: what its answer carries of the page it rendered for (`''`: nothing). */
	tail(): string;
	/** A hole minted in this render: the address part naming the page facts it renders from
	 *  (`&pv=…`), `''` for a hole whose tree reads no `page.data`. */
	version(hole_id: string): string;
}
interface Slots {
	reader: Reader | null;
	event_reader: EventReader | null;
	render_page?: RenderPagePort | null;
}

const SLOT = Symbol.for('ogygia.kit-context');
const slots: Slots = ((globalThis as unknown as Record<symbol, Slots | undefined>)[SLOT] ??= {
	reader: null,
	event_reader: null
});

/** hooks.ts installs the request-scoped reader (page snapshot + live event). */
export function set_kit_page_reader(fn: Reader | null): void {
	slots.reader = fn;
}

/** hooks.ts installs the live `RequestEvent` reader — what `requestEvent()` (public, isomorphic)
 *  hands a server island: `locals`, `cookies`, `url`, `request` of the request rendering it. */
export function set_kit_event_reader(fn: EventReader | null): void {
	slots.event_reader = fn;
}

/** hooks.ts installs the render-page port: in a request rendering for a page it is not (a hole, a
 *  remote call), that page is looked up once (server/page-facts.ts) so the reader answers from it,
 *  and an answer carries the facts its islands read. */
export function set_render_page_port(port: RenderPagePort | null): void {
	slots.render_page = port;
}

/**
 * Await before an async render root starts: the page this render belongs to, ready for the reader.
 * Inside a page request, on the client, or for a render that reads no `page.data`: nothing to wait for
 * (`undefined`, no microtask).
 */
export function kit_page_ready(reads_data: boolean | null = null): Promise<void> | void {
	return slots.render_page?.ready(reads_data);
}

/** Append to a render root's HTML: the page facts its islands read, when it rendered for a page. */
export function kit_page_facts_tail(): string {
	return slots.render_page?.tail() ?? '';
}

/** Append to a minted hole endpoint: its page version (server/render-page.ts), or `''`. */
export function kit_page_version(hole_id: string): string {
	return slots.render_page?.version(hole_id) ?? '';
}

/** The live event the installed reader answers (null off-request / on the client). */
export function kit_request_event(): unknown | null {
	return slots.event_reader?.() ?? null;
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

/** A frozen server-side store: the value is known for the whole render, nothing ever changes it
 *  (Kit's own page render uses `writable`s it never writes after start). Hand-rolled so this
 *  module stays dependency-free for the client graph. */
function frozen_store<T>(value: T) {
	return {
		subscribe(fn: (value: T) => void) {
			fn(value);
			return () => {};
		}
	};
}

/** Kit's `__svelte__` context shape: what `getStores()` in `$app/stores` destructures. */
function kit_stores_context(page: KitPage) {
	return {
		page: frozen_store(page),
		navigating: frozen_store(null),
		updated: { ...frozen_store(false), check: async () => false }
	};
}

/** The `context` option for a `svelte/server` `render()` ogygia starts. An explicit `page` (the
 *  document root, built from the router's seed) wins; else the request reader; else empty. Both
 *  of Kit's contexts ride along: `__request__` for `$app/state`, `__svelte__` for `$app/stores`.
 *  The `__request__` entry also carries the live `event` (Kit's own render sets `{ page }` only)
 *  — the channel `requestEvent()` reads, so a server island can see its request without importing
 *  `$app/server` (which Kit's client guard rejects the moment a csr=true page shares the layout). */
export function kit_render_context(page?: KitPage, event?: unknown): Map<string, unknown> {
	const resolved = page ?? slots.reader?.() ?? empty_kit_page();
	const live = event ?? slots.event_reader?.() ?? null;
	return new Map<string, unknown>([
		[KIT_REQUEST_CONTEXT, { page: resolved, event: live }],
		[KIT_STORES_CONTEXT, kit_stores_context(resolved)]
	]);
}
