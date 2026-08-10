/**
 * In-process bridge between the ogygia Vite plugin and a svelte preprocessor.
 *
 * The marked-import transform must run on CLEAN svelte, which for `.svx` / `.md` only exists AFTER
 * mdsvex has preprocessed the file — a stage no Vite plugin can wedge into. So a preprocessor
 * (composed into `@ogygia/content`'s `markdown()` after mdsvex) runs the transform instead. But
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
};

// The plugin runs in Vite's config context; the preprocessor runs in the app/compile context. A
// plain module singleton can be two instances across that boundary (esbuild may bundle ogygia into
// the config, or externalize it). A `Symbol.for` global slot is shared across every context in the
// process, so the bridge the plugin sets is the one the preprocessor reads.
const KEY = Symbol.for('ogygia.island-bridge.v1');
const g = globalThis as unknown as Record<symbol, IslandBridge>;
export const islandBridge: IslandBridge = (g[KEY] ??= {
	transform: null,
	scan: null,
	markdownConfig: null
});
