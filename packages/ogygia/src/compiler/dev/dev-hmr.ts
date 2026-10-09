/**
 * Client bridge source for `virtual:ogygia/dev-hmr` (vite serve only). Pure codegen: it returns the
 * JS text the adapter serves for the dev soft-CSS-HMR bridge. No build state.
 */

/**
 * Client bridge source for `virtual:ogygia/dev-hmr` (vite serve only): a LAZY map of app CSS under
 * `/src`, joined per-file when the plugin broadcasts a scoped `ogygia:css` event — plus full-reload
 * on `vite:error`.
 *
 * LAZY is load-bearing. The bridge used to join every `/src` stylesheet EAGERLY, which painted the
 * whole app's CSS onto every page — invisible while one app owned one look, but the moment two
 * sub-apps share one project (the `(docs)` / `playground` split), each page wore the other's skin
 * in dev while prod (Kit's per-route CSS) stayed clean. Now a page boots with exactly its SSR CSS,
 * and joins a stylesheet only when it changes AND this page's route scope owns it (the
 * `ogygia-dev-scope` meta the handle stamps vs. the owners the plugin derives from the module
 * graph). Once joined, later edits soft-apply through Vite's normal CSS HMR.
 *
 * Do **not** strip Kit’s `<style data-sveltekit>` FOUC bag. Under `csr = false` that bag is
 * how page + component CSS is delivered (no client module graph for route shells). Removing
 * it blanks the page; a MutationObserver would also delete FOUC styles the SPA router merges
 * in on navigation.
 *
 * @internal Emitted by the plugin; exported for unit tests.
 */
export function dev_hmr_client_source() {
	return (
		`import "/@vite/client";\n` +
		`const css_modules = import.meta.glob("/src/**/*.{css,scss,sass,less,styl}", { eager: false });\n` +
		`const scope_meta = document.querySelector('meta[name="ogygia-dev-scope"]');\n` +
		`const scope = scope_meta ? scope_meta.getAttribute("content") || "" : "";\n` +
		`// Soft path: scoped join on first change, then Vite CSS HMR (injected after FOUC; later rules win).\n` +
		`// Hard path: anything Vite can't apply.\n` +
		`function ogygia_full_reload() {\n` +
		`  location.reload();\n` +
		`}\n` +
		`if (import.meta.hot) {\n` +
		`  import.meta.hot.accept();\n` +
		`  import.meta.hot.on("vite:error", ogygia_full_reload);\n` +
		`  import.meta.hot.on("ogygia:css", (d) => {\n` +
		`    const p = d && d.path;\n` +
		`    if (!p || !css_modules[p]) return;\n` +
		`    const owners = (d && d.owners) || [];\n` +
		`    // Join only what this page's sub-app owns; ownerless css (shared / undeterminable) joins anywhere.\n` +
		`    if (owners.length && owners.indexOf(scope) === -1) return;\n` +
		`    css_modules[p]();\n` +
		`  });\n` +
		`}\n`
	);
}
