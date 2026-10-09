/**
 * Component → CSS registry for the SERVER router (`ogygia/router`).
 *
 * A router page/layout/error component is a runtime VALUE (`r.page(Home)`), so unlike a Kit route
 * there is no file-derived place to link its stylesheets from — historically its `<style>` never
 * reached the page (see link/router-css.ts for the whole story). The fix is Kit's association done
 * value-wise: the build emits `virtual:ogygia/router-css`, a generated module (never user code) that
 * imports each component the app's router modules can reach and registers it HERE with a thunk
 * yielding its stylesheet entries. `render_page` then looks up exactly the components it renders and
 * links them through `document()`'s head.
 *
 * The thunk shape covers both modes:
 *  - prod:  `{ key, href }` — `<link rel="stylesheet">` to the emitted asset (key = the raw handoff
 *           href, so `claim_region_css` dedupes against a held region linking the same sheet).
 *  - dev:   `{ key, css }`  — inline `<style>` text compiled at emit time (Vite dev has no built
 *           asset to link; Kit inlines dev styles the same way).
 *
 * WeakMap: components registered but never rendered cost one entry, GC'd with the module graph.
 */

export interface RouterCssEntry {
	/** Per-request dedupe key (claimed via `claim_region_css`, shared with region CSS claims). */
	key: string;
	/** Prod: stylesheet URL (base applied by the generated virtual). */
	href?: string;
	/** Dev: inline CSS text. */
	css?: string;
}

const registry = new WeakMap<object, () => RouterCssEntry[]>();

/** DEV registrations, keyed by the component's source path — pure DATA, no component imports.
 *
 *  Structural constraint (learned the hard way): the generated dev virtual must not `import` the
 *  components it registers. The virtual is reachable from `ogygia/router` — which the profiler's
 *  handle welds into the graph territory SvelteKit's dev "inline all styles" collector can crawl
 *  from ANY page (via Kit's generated internal.js → hooks). Component imports would drag every
 *  router page's whole tree — scoped styles, plain `.css` imports — into that crawl, leaking a
 *  router page's stylesheets into unrelated app pages. So dev registers `path → entries` data and
 *  the lookup matches through Svelte's own dev metadata instead (see `filename_of`). */
const path_registry = new Map<string, RouterCssEntry[]>();

/** Called by the generated `virtual:ogygia/router-css` — one registration per reachable component. */
export function register_router_css(component: unknown, entries: () => RouterCssEntry[]): void {
	if (
		(typeof component === 'function' || (typeof component === 'object' && component !== null)) &&
		!registry.has(component as object)
	) {
		registry.set(component as object, entries);
	}
}

/** Dev-mode registration: `abs posix source path → entries`, no component identity needed. */
export function register_router_css_paths(map: Record<string, RouterCssEntry[]>): void {
	for (const key in map) path_registry.set(key, map[key]);
}

/** A dev-compiled Svelte 5 component carries its source path under svelte's `Symbol(filename)`
 *  (`Comp[$.FILENAME] = '/abs/….svelte'` — dev only). Read it by symbol DESCRIPTION rather than
 *  importing `svelte/internal/*`: this module is realm-shared, and pulling either internal entry
 *  would drag the wrong svelte runtime into the other realm's bundle. */
function filename_of(component: object): string | undefined {
	const sym = Object.getOwnPropertySymbols(component).find((s) => s.description === 'filename');
	const v = sym ? (component as Record<symbol, unknown>)[sym] : undefined;
	return typeof v === 'string' ? v : undefined;
}

/** The stylesheet entries for one rendered component — [] when unregistered (no styles, or the
 *  component reached the router outside its modules' import graph; dev warns on that case). */
export function router_css_of(component: unknown): RouterCssEntry[] {
	if (typeof component !== 'function' && (typeof component !== 'object' || component === null))
		return [];
	const thunk = registry.get(component as object);
	if (thunk) {
		try {
			return thunk() ?? [];
		} catch {
			return []; // a broken handoff read must degrade to unstyled, never crash the render
		}
	}
	if (path_registry.size) {
		const file = filename_of(component as object);
		if (file) return path_registry.get(file) ?? [];
	}
	return [];
}

/** Dev-only: was this component registered at all? Lets the router warn when a STYLED component
 *  reached it from outside the detected import closure (the `makeRoutes(Comp)` injection pattern). */
export function router_css_known(component: unknown): boolean {
	if (typeof component !== 'function' && (typeof component !== 'object' || component === null))
		return false;
	if (registry.has(component as object)) return true;
	if (path_registry.size) {
		const file = filename_of(component as object);
		if (file) return path_registry.has(file);
	}
	return false;
}
