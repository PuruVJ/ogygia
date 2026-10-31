/**
 * In-process bridge between the `content()` plugin (vite config) and the markdown preprocessor (svelte
 * config) and macros.
 *
 * The marked-import transform must run on CLEAN svelte, which for `.svx` / `.md` only exists AFTER
 * mdsvex has preprocessed the file — a stage no Vite plugin can wedge into. So the preprocessor runs
 * the island transform itself, through the closure ogygia's build hands `b.markup()`: that closure is
 * bound to the configured ogygia instance (ids, salt, options and the shared island registry all match).
 *
 * The plugin runs in Vite's config context; the preprocessor runs in the svelte compile context. A
 * plain module singleton can be two instances across that boundary (the config may bundle the package
 * or externalize it), so the bridge lives on a `Symbol.for` global slot shared by the whole process.
 */
export type ContentBridge = {
	/** Rewrite marked imports in already-preprocessed svelte + register the islands (`b.markup()`'s
	 *  transform). The code, or null when nothing changed / ogygia isn't configured yet. */
	transform: ((source: string, filename: string) => string | null) | null;
	/** Build-time island discovery for the markdown corpus (the preprocessor sets it; ogygia awaits it
	 *  at build start through the markup source). No-op when unset. */
	scan:
		| ((ctx: { root: string; readFile: (abs: string) => string | null }) => void | Promise<void>)
		| null;
	/** The `content({ markdown })` config. The preprocessor reads it when called with no args, so all
	 *  config lives in the vite config and the svelte config references a value-free `preprocess()`. */
	markdownConfig: Record<string, unknown> | null;
	/**
	 * Named content presets from `content({ presets })` — each a partial content config
	 * (`{ markdown: {…} }`) referenced by a LITERAL `preset: 'name'` on a loader macro. The macro
	 * checks the name here at rewrite time; the preprocessor merges the named bag over
	 * {@link markdownConfig} (depth-2: per setting key) for each `?og_preset=` module VARIANT the
	 * referencing collection's glob mints. `null` when none configured.
	 */
	contentPresets: Record<string, { markdown?: Record<string, unknown> }> | null;
	/**
	 * Content modules (`.svx`/`.md`) that carry their OWN scoped `<style>`, absolute path → their
	 * post-mdsvex Svelte source. Handed to ogygia as the markup source's `styles`: the build compiles
	 * each one's CSS and ships it as a client asset (the leak-free corpus never enters the client graph).
	 */
	contentStyleSources: Map<string, string>;
};

const KEY = Symbol.for('ogygia.content-bridge.v1');
const g = globalThis as unknown as Record<symbol, ContentBridge>;
export const bridge: ContentBridge = (g[KEY] ??= {
	transform: null,
	scan: null,
	markdownConfig: null,
	contentPresets: null,
	contentStyleSources: new Map<string, string>()
});
