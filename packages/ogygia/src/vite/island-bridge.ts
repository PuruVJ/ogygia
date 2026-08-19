/**
 * In-process bridge between the ogygia Vite plugin and a svelte preprocessor.
 *
 * The marked-import transform must run on CLEAN svelte, which for `.svx` / `.md` only exists AFTER
 * mdsvex has preprocessed the file — a stage no Vite plugin can wedge into. So a preprocessor
 * (composed into `ogygia/content`'s `markdown()` after mdsvex) runs the transform instead. But
 * the transform's islands must reach THIS plugin instance's registry to be emitted / resolved.
 *
 * The plugin sets `islandBridge.transform` to a closure bound to its `run_transform` + `register`
 * (so ids, salt, options, and the shared registry all match); the preprocessor calls it. Both live
 * in the same ogygia module instance in one Vite process, so the singleton is shared.
 */
type IslandBridge = {
	/** Rewrite marked imports in already-preprocessed svelte + register the islands. Returns the
	 *  rewritten code, or null when nothing changed / the plugin isn't active. */
	transform: ((source: string, filename: string) => string | null) | null;
	/**
	 * Build-time island discovery for source ogygia's own scan can't read (e.g. markdown that only
	 * becomes Svelte after a preprocessor). A preprocessor package sets this; the plugin awaits it in
	 * `buildStart` so those islands are registered before island chunks are emitted. ogygia stays
	 * agnostic about the source format — the scanner does the format-specific work and calls
	 * {@link transform} to register. No-op when unset.
	 */
	scan:
		| ((ctx: {
				root: string;
				readFile: (abs: string) => string | null;
		  }) => void | Promise<void>)
		| null;
	/**
	 * Markdown config the user passes to `ogygia({ content: { markdown } })`. The `markdown()`
	 * preprocessor reads it here when called with no args, so all config lives in the one plugin —
	 * the svelte config only references a value-free `markdown()`. `null` when not set.
	 */
	markdownConfig: Record<string, unknown> | null;
	/**
	 * Named content presets from `ogygia({ content: { presets } })` — each a partial content-config
	 * (`{ markdown: {…} }`) referenced by a LITERAL `preset: 'name'` on a loader macro. The macro
	 * checks the name here at rewrite time; the preprocessor merges the named bag over
	 * {@link markdownConfig} (depth-2: per setting key) for each `?og_preset=` module VARIANT the
	 * referencing collection's glob mints. `null` when none configured.
	 */
	contentPresets: Record<string, { markdown?: Record<string, unknown> }> | null;
	/**
	 * Content modules (`.svx`/`.md`) that carry their OWN scoped `<style>`, keyed by absolute path →
	 * their post-mdsvex Svelte source (the markdown scanner's compile output). The plugin's client leg
	 * runs `svelte.compile` on this source to extract the scoped CSS and emits it as a client asset
	 * (Svelte resolves `:global`; the default `cssHash` reproduces the SSR'd HTML's scoped hash).
	 * Necessary because a content module's scoped CSS otherwise compiles into the SERVER bundle only
	 * (the leak-free corpus never enters the client graph), so on a csr=false doc page it would ship on
	 * no stylesheet.
	 */
	contentStyleSources: Map<string, string>;
};

/**
 * Stable cross-build key for a content module's own scoped CSS. Computed IDENTICALLY from the same
 * absolute filename by the preprocessor (which bakes `__ogygia_css` into the module) and the plugin
 * (which emits the CSS chunk + writes the handoff), so the two agree without threading `root`: the
 * path from the first `/src/` segment, POSIX. `/…/proj/src/content/docs/x.svx` → `content/docs/x.svx`.
 */
const BACKSLASHES = /\\/g;
const LEADING_SLASH = /^\//;
export function content_css_key(abs: string): string {
	const p = abs.replace(BACKSLASHES, '/').split('?')[0];
	const i = p.indexOf('/src/');
	return i >= 0 ? p.slice(i + 5) : p.replace(LEADING_SLASH, '');
}

// The plugin runs in Vite's config context; the preprocessor runs in the app/compile context. A
// plain module singleton can be two instances across that boundary (esbuild may bundle ogygia into
// the config, or externalize it). A `Symbol.for` global slot is shared across every context in the
// process, so the bridge the plugin sets is the one the preprocessor reads.
const KEY = Symbol.for('ogygia.island-bridge.v1');
const g = globalThis as unknown as Record<symbol, IslandBridge>;
export const islandBridge: IslandBridge = (g[KEY] ??= {
	transform: null,
	scan: null,
	markdownConfig: null,
	contentPresets: null,
	contentStyleSources: new Map<string, string>()
});
