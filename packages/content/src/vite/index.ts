/**
 * `content()` — content collections, markdown and the content macros, listed beside `ogygia()` in
 * vite.config `plugins` (`content({ markdown, presets })`). The svelte config takes the value-free
 * halves from here too:
 *
 * ```js
 * // svelte.config.js
 * import { preprocess, extensions } from '@ogygia/content/vite';
 * export default { extensions: extensions(), preprocess: [vitePreprocess(), ...preprocess()] };
 * ```
 *
 * The plugin brings `import.meta.og.code` / `.md` (a snippet baked through the app's own fence
 * pipeline), `import.meta.og.loader.*` (a static content source) and `import.meta.og.regions` (a block
 * registry), registers markdown as a markup source (its islands and its modules' own CSS reach the
 * build), and the dev HMR that reloads catalogs when a content file changes.
 */
import path from 'node:path';
import type { PreprocessorGroup } from 'svelte/compiler';
import type { Plugin as VitePlugin } from 'vite';
import { definePlugin, type OgygiaPlugin } from '@ogygia/core/vite';
import { bridge } from '../bridge.ts';
import { ogygiaPresetPreprocess, type MarkdownOptions } from '../markdown/index.ts';
import { snippet_macros } from '../macros/snippets.ts';
import { rewrite_loaders } from '../macros/loaders.ts';
import { rewrite_regions } from '../macros/regions.ts';
import { materialize } from '../macros/git.ts';
import { content_hmr, type ContentHmrOptions } from './hmr.ts';

export { invalidateModuleTree } from './hmr.ts';
export type { ContentHmrOptions };

// ── regexes
const CONTENT_CALL_RE = /\bcontent\s*\(/;
const SERVER_MODULE_EXT_RE = /\.(server|remote)\.(ts|js|mjs)$/;
const SERVER_DIR_RE = /\/(src\/lib\/server|server)\//;
const OG_PRESET_QUERY_RE = /[?&]og_preset=([\w-]+)/;
const IDENT_NAME_RE = /^[\w-]+$/;
const JS_MODULE_RE = /\.(ts|js|mjs)$/;

const DEFAULT_EXTENSIONS = ['.svx', '.md'];

/**
 * A named content preset — a partial content config referenced by a literal `preset: 'name'` on a
 * loader macro (`import.meta.og.loader.folder('../docs', { preset: 'name' })`). The referencing
 * collection's files compile as their own module VARIANTS (`?og_preset=name`), so the same file used
 * by another collection under another preset renders independently — never a conflict.
 */
export interface ContentPreset {
	/** Markdown options merged over `markdown` (per setting key — depth-2 replace). */
	markdown?: MarkdownOptions;
}

export interface ContentOptions extends ContentHmrOptions {
	/** The markdown pipeline (mdsvex + Shiki: themes, remark plugins, heading ids…): the defaults for
	 *  every markdown file. Setting it turns markdown on (`extensions()` adds its extensions). */
	markdown?: MarkdownOptions;
	/** Named variants a loader macro opts a whole collection into (`{ preset: 'name' }`). Requires
	 *  `markdown` (the defaults every preset merges over; an empty `markdown: {}` is fine). */
	presets?: Record<string, ContentPreset>;
}

export function content(options: ContentOptions = {}): [OgygiaPlugin, ...VitePlugin[]] {
	const { markdown, presets, ...hmr } = options;
	if (presets) validate_presets(presets, !!markdown);
	// The svelte config's `preprocess()` / `extensions()` read this; vite.config evaluates the plugin
	// list before `sveltekit()` loads the svelte config, so it is set by then.
	bridge.markdownConfig = (markdown as Record<string, unknown> | undefined) ?? null;
	bridge.contentPresets = (presets as ContentBridgePresets | undefined) ?? null;
	const exts = markdown_extensions();

	let root = '';
	const plugin = definePlugin({
		name: '@ogygia/content',
		build(b) {
			root = b.root;
			for (const { name, handler } of snippet_macros(
				() => bridge.markdownConfig as MarkdownOptions | null
			))
				b.macro(name, handler);
			b.macro('loader', (code, m) => {
				if (!JS_MODULE_RE.test(m.id)) {
					if (m.id.endsWith('.svelte') && !m.id.includes('/node_modules/'))
						console.warn(
							`[ogygia/content] ${m.rel} calls import.meta.og.loader.* inside a component. ` +
								`Loaders build a content corpus and are server-only — move the collection to a \`.server.ts\` ` +
								`module and cross the wire with remotes. (In a component it never rewrites and fails at runtime.)`
						);
					return code;
				}
				// `git` first materializes a shallow checkout into the app's content cache (sync,
				// idempotent, lock-gated) and points the glob at it, before Vite's glob plugin scans it.
				const { code: rewritten, specs } = rewrite_loaders(code, m.id);
				for (const spec of specs) materialize(spec, { root: m.root });
				return rewritten;
			});
			b.macro('regions', (code, m) =>
				JS_MODULE_RE.test(m.id) ? rewrite_regions(code, m.id) : code
			);
			if (markdown) {
				const islands = b.markup({
					extensions: exts,
					scan: (ctx) => bridge.scan?.(ctx),
					styles: bridge.contentStyleSources
				});
				bridge.transform = islands.transform;
			}
		}
	});
	return [plugin, content_hmr(hmr), content_checks(() => root, exts)];
}

type ContentBridgePresets = NonNullable<typeof bridge.contentPresets>;

/**
 * The pre-transform: tag a content-preset module variant (`?og_preset=name`) for the preprocessor,
 * and nudge when a collection is defined outside a server-only module.
 */
function content_checks(get_root: () => string, exts: readonly string[]): VitePlugin {
	const warned = new Set<string>();
	return {
		name: 'ogygia:content-checks',
		enforce: 'pre',
		transform(code, id) {
			// vite-plugin-svelte strips the query from the `filename` its preprocessors see, so the id
			// can't carry the preset that far — this pre-transform (which DOES see the full id) tags the
			// raw markdown with a one-line end-of-file marker; the preprocessor reads it, strips it, and
			// compiles with the preset's merged config. At the END so frontmatter stays on line one.
			const q = id.indexOf('?');
			if (bridge.contentPresets && q !== -1 && id.includes('og_preset=')) {
				const m = OG_PRESET_QUERY_RE.exec(id);
				const file = id.slice(0, q);
				if (m && exts.some((e) => file.endsWith(e))) {
					if (!bridge.contentPresets[m[1]])
						throw new Error(
							`[ogygia/content] '${id}': unknown content preset '${m[1]}' in the module query. Configured: ${Object.keys(bridge.contentPresets).join(', ')}.`
						);
					return { code: `${code}\n<!--og_preset:${m[1]}-->`, map: null };
				}
			}
			warn_placement(get_root(), q === -1 ? id : id.slice(0, q), code, warned);
			return null;
		}
	};
}

/**
 * Nudge (never error): a `content()` collection defined OUTSIDE a server-only module. Kit's own guard
 * makes `.server.ts` / `src/lib/server/` / `.remote.ts` mechanically un-importable from client code —
 * anywhere else, one innocent import from an island or route component can drag the whole corpus
 * (megabytes of compiled markdown) into a client bundle, silently. Warn once per file.
 */
function warn_placement(root: string, file: string, code: string, warned: Set<string>): void {
	if (!root || !JS_MODULE_RE.test(file) || warned.has(file)) return;
	// app source only — never library code
	if (!file.startsWith(path.join(root, 'src') + path.sep)) return;
	const defines_collection = code.includes('@ogygia/content') && CONTENT_CALL_RE.test(code);
	if (!defines_collection && !code.includes('import.meta.og.loader.')) return;
	if (SERVER_MODULE_EXT_RE.test(file) || SERVER_DIR_RE.test(file.slice(root.length))) return;
	warned.add(file);
	console.warn(
		`[ogygia/content] ${path.relative(root, file)} defines a collection outside a server-only module. ` +
			`Move it to a \`.server.ts\` file (or \`src/lib/server/\`) and mint remotes for the wire — ` +
			`Kit then guarantees the corpus can never reach a client bundle.`
	);
}

/**
 * Config-time content-preset validation — closed vocabulary (only `markdown`), non-empty, identifier
 * names, and `markdown` required (the defaults are the base every preset merges over).
 */
function validate_presets(presets: Record<string, unknown>, has_markdown: boolean): void {
	if (!has_markdown)
		throw new Error(
			'[ogygia/content] `presets` requires `markdown` — the defaults are the base every preset merges over (an empty `markdown: {}` is fine).'
		);
	for (const [name, bag] of Object.entries(presets)) {
		if (!IDENT_NAME_RE.test(name))
			throw new Error(
				`[ogygia/content] presets: '${name}' — preset names are identifiers ([A-Za-z0-9_-]).`
			);
		if (!bag || typeof bag !== 'object' || Object.keys(bag).length === 0)
			throw new Error(
				`[ogygia/content] presets.${name} is empty — a preset with nothing is a mistake.`
			);
		for (const k of Object.keys(bag))
			if (k !== 'markdown')
				throw new Error(
					`[ogygia/content] presets.${name}: unknown key \`${k}\`. A content preset takes \`markdown\`.`
				);
	}
}

function markdown_extensions(): string[] {
	const cfg = bridge.markdownConfig as MarkdownOptions | null;
	return cfg?.extensions ? [...cfg.extensions] : DEFAULT_EXTENSIONS;
}

/**
 * The svelte config's markdown preprocessor. Spread into `preprocess`:
 * `preprocess: [vitePreprocess(), ...preprocess()]`. The markdown preprocessor when
 * `content({ markdown })` is set, otherwise nothing. mdsvex loads lazily on first use.
 */
// NOTE(deferred-types, 2026-09-01): a preprocessor that rewrote `render:'deferred'` imports to
// type the reserved `ogygiaFallback` snippet was built and REVERTED — svelte-check/language-tools
// type the ORIGINAL source and ignore script preprocessors' output for diagnostics (probe-proven),
// so no preprocessor can augment call-site types. Server islands hand-declare the prop instead.
export function preprocess(): PreprocessorGroup[] {
	return bridge.markdownConfig ? [ogygiaPresetPreprocess()] : [];
}

/** The svelte config's full `extensions` list: `.svelte`, plus markdown's when `content({ markdown })`
 *  is set. Pass it straight through: `extensions: extensions()`. */
export function extensions(): string[] {
	return bridge.markdownConfig ? ['.svelte', ...markdown_extensions()] : ['.svelte'];
}
