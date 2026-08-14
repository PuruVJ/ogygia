/**
 * Opinionated markdown for Kit content apps: mdsvex + Shiki.
 *
 * Drop into `svelte.config.js` — discovery stays `import.meta.glob` + `format: mdsvex`.
 *
 * ```js
 * import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
 * import { markdown } from 'ogygia/content/markdown';
 *
 * export default {
 *   extensions: ['.svelte', ...markdown.extensions],
 *   preprocess: [vitePreprocess(), markdown()]
 * };
 * ```
 */

import type { MdsvexOptions } from 'mdsvex';
import type { PreprocessorGroup, Processed } from 'svelte/compiler';
import { islandBridge } from '../../vite/island-bridge.js';
import { remarkHeadingId } from './remark-heading-id.js';
import { remarkHeadings, type RemarkHeadingsOptions } from './remark-headings.js';
import { remarkLinks } from './remark-links.js';
import { remarkCodeIds } from './remark-code-ids.js';
import { transform_containers } from './containers.js';
import { transform_tabs } from './tabs.js';
import { rehypeHeadingAnchors } from './rehype-heading-anchors.js';
import { DEFAULT_OVERRIDE_TAGS, rehypeOverrides, SLOT_TAG } from './rehype-overrides.js';
import {
	configure_shiki,
	create_mdsvex_highlighter,
	type MarkdownShikiOptions,
	type MarkdownThemePair
} from './shiki.js';

export type { MarkdownShikiOptions, MarkdownThemePair, RemarkHeadingsOptions };
export type { Heading } from '../index.js';
export { highlight, escape_svelte, wrap_html, normalize_shiki } from './shiki.js';
export { remarkHeadingId } from './remark-heading-id.js';
export { remarkHeadings, slugify } from './remark-headings.js';
export { remarkLinks } from './remark-links.js';
export { parseFrontmatter } from './frontmatter.js';
export type { FrontmatterResult } from './frontmatter.js';

/** Default file extensions handled by {@link markdown}. */
export const extensions = ['.svx', '.md'] as const;

export type MarkdownOptions = MarkdownShikiOptions & {
	/**
	 * Enable pandoc-style `## Title {#id}` heading ids (default `true`).
	 */
	headingIds?: boolean;
	/**
	 * Collect h2–h4 into `metadata.headings` (auto-slugging ids that lack `{#id}`) so `render()`
	 * can hand consumers a TOC. Default `true`. Pass an options object to tune the depth range.
	 */
	headings?: boolean | RemarkHeadingsOptions;
	/**
	 * Wrap overridable markdown elements in the pharos slot so a pharos site's `components` map can
	 * replace how they render (id-form links, optimized images, custom code, …). `true` uses the
	 * default tag set (`a`, `img`, `code`); pass `{ tags }` to widen. Off by default — a non-pharos
	 * content app must not carry the slot. The component VALUES live in `pharos()`, never here.
	 */
	overrides?: boolean | { tags?: string[] };
	/**
	 * VitePress-compatible custom containers — `::: tip`, `::: warning`, `::: danger`, `::: info`,
	 * `::: note`, `::: caution`, `::: important`, and collapsible `::: details` (optional title on the
	 * open line). Default `true`; only fires on `:::` syntax, so it's inert otherwise. See `containers.ts`.
	 */
	containers?: boolean;
	/**
	 * Markdown-native tab groups — `::: code-group` (VitePress-style, `[label]` on each fence) and
	 * `::: tabs` (one tab per `== Label`). Rewritten to `<TabGroup>`/`<Tab>` with the components auto-injected,
	 * so authors need no imports. Default `true`; only fires on the opener syntax. See `tabs.ts`.
	 */
	tabs?: boolean;
	/** Add a hover permalink `<a>` (link icon) to every heading with an id. Default `true`. */
	headingAnchors?: boolean;
	/** Give every code block a stable content-hash id (`slug-code-<hash>`) so it can be permalinked, in
	 *  the SSR HTML (works on cold load). Default `true`. See `remark-code-ids.ts`. */
	codeIds?: boolean;
	/** Extra remark plugins (after heading-id / heading collection). */
	remarkPlugins?: MdsvexOptions['remarkPlugins'];
	/** Extra rehype plugins. */
	rehypePlugins?: MdsvexOptions['rehypePlugins'];
	/** Override extensions (default `.svx` / `.md`). */
	extensions?: string[];
	/** Forwarded to mdsvex `layout`. */
	layout?: MdsvexOptions['layout'];
};

/**
 * Load the optional `mdsvex` peer on demand, with a clear install hint if it's absent. Keeps mdsvex
 * (and its heavy transitive deps) out of this module's static import graph, so `content/markdown` —
 * and therefore `ogygia.preprocess()` — can be imported synchronously by apps that don't use it.
 */
async function load_mdsvex(): Promise<typeof import('mdsvex').mdsvex> {
	try {
		return (await import('mdsvex')).mdsvex;
	} catch {
		throw new Error(
			'[ogygia] Markdown content needs the optional peer dependency "mdsvex". Install it:\n' +
				'  npm i -D mdsvex   (or the pnpm / yarn / bun equivalent)'
		);
	}
}

/** Pull the emitted `code` out of a preprocessor `markup` result (whose type includes `void`),
 *  falling back to the original input when the hook returned nothing. */
function markup_code(out: Processed | void | undefined, fallback: string): string {
	const p = out as Processed | undefined;
	return p ? p.code : fallback;
}

/** Rewrite marked island imports in already-mdsvex'd Svelte via the plugin's in-process bridge
 *  (the plugin owns `transform`; we register `scan`). No-op when the ogygia plugin isn't active. */
function transform_islands(content: string, filename: string): string | null {
	return islandBridge.transform ? islandBridge.transform(content, filename) : null;
}

/**
 * Inject a lazy `__ogygia_source` export — a self-import of the file's own `?raw` variant — into the
 * compiled module. The specifier is a STATIC LITERAL (`./<basename>?raw`), so Vite analyzes it and
 * code-splits the raw text into its own chunk; the bytes load only when `source()` is called and
 * never reach the client. This is how a content entry carries its own pre-compile source (powering
 * `emit.raw`, "copy as markdown", llms-full, …) with no parallel `?raw` glob in app code.
 */
function source_line(filename: string): string | null {
	const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
	if (!base) return null;
	return `export const __ogygia_source = () => import(${JSON.stringify('./' + base + '?raw')}).then((m) => m.default);`;
}

/** Inject module-script lines (a `source` export, a slot import) into the compiled module. */
function inject_module(code: string, lines: string[]): string {
	if (!lines.length) return code;
	const block = lines.join('\n');
	// Inject into the existing module script (Svelte 5 `<script module>` or legacy `context="module"`),
	// else prepend a fresh one. Never two module scripts (illegal).
	const open = /<script\b[^>]*\b(?:context\s*=\s*(["'])module\1|module)\b[^>]*>/.exec(code);
	if (open) {
		const at = open.index + open[0].length;
		return code.slice(0, at) + '\n' + block + code.slice(at);
	}
	return `<script context="module">\n${block}\n</script>\n` + code;
}

/**
 * Register a build-time island scanner on the bridge so islands authored inside `.svx` / `.md`
 * content get their client chunks emitted. ogygia's own scan (in `buildStart`) reads only
 * `.svelte` / `.ts`; a content page becomes Svelte only after mdsvex, which is our job. The scanner
 * walks `src` for the configured extensions, runs mdsvex, and registers each via
 * {@link transform_islands}. Set synchronously at config time — always before `buildStart` reads it.
 */
function register_island_scanner(
	run_markup: (content: string, filename: string) => Promise<unknown>,
	exts: readonly string[]
): void {
	islandBridge.scan = async ({
		root,
		readFile
	}: {
		root: string;
		readFile: (abs: string) => string | null;
	}) => {
		const { readdirSync } = await import('node:fs');
		const { join } = await import('node:path');
		const files: string[] = [];
		const walk = (dir: string) => {
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				if (e.isDirectory()) {
					// Match ogygia's own prescan: skip only build/vendor dirs, not every dot-dir (a
					// legit `src/.generated/` content dir could hold pages Kit's glob still imports).
					if (e.name === 'node_modules' || e.name === '.svelte-kit' || e.name === '.git') continue;
					walk(join(dir, e.name));
				} else if (exts.some((x) => e.name.endsWith(x))) {
					files.push(join(dir, e.name));
				}
			}
		};
		walk(join(root, 'src'));
		for (const file of files) {
			const raw = readFile(file);
			if (raw == null) continue;
			// The FULL markup pipeline of a real compile — `:::` tab rewrite + island import injection
			// → mdsvex → island transform (which registers). Running only mdsvex here would miss the
			// islands the tab pass mints, so their client chunks would never be emitted at build.
			await run_markup(raw, file);
		}
	};
}

/**
 * ogygia's svelte preprocessor — mdsvex (Shiki fences + heading ids) with the island transform
 * composed after it, so islands authored inside `.svx` / `.md` become real islands.
 *
 * Called with **no args** it reads its config from `ogygia({ content: { markdown } })`, so all
 * config lives in the one plugin and the svelte config only needs the value-free call:
 *
 * ```js
 * extensions: ogygia.extensions(),
 * preprocess: [vitePreprocess(), ...ogygia.preprocess()],
 * ```
 *
 * Pass options directly to override (`ogygiaPreprocess({ themes })`). Synchronous: mdsvex (an
 * optional peer) is loaded and constructed lazily on first use via {@link load_mdsvex}, so importing
 * this module — and calling this — never requires mdsvex to be installed.
 */
export function ogygiaPreprocess(options?: MarkdownOptions): PreprocessorGroup {
	const {
		headingIds = true,
		headings = true,
		overrides = false,
		containers = true,
		tabs = true,
		headingAnchors = true,
		codeIds = true,
		remarkPlugins = [],
		rehypePlugins,
		extensions: exts = [...extensions],
		layout,
		...shiki_opts
	} = options ?? (islandBridge.markdownConfig as MarkdownOptions | null) ?? {};

	// Element overrides: which tags get wrapped in the pharos slot (values live in `pharos()`).
	const override_tags = overrides ? (overrides === true ? [...DEFAULT_OVERRIDE_TAGS] : (overrides.tags ?? [...DEFAULT_OVERRIDE_TAGS])) : [];

	const cfg = configure_shiki(shiki_opts);

	// heading-id (explicit `{#id}`) must run before the collector so explicit ids win.
	// Passed as `[attacher, options]` (unified/mdsvex plugin form), not called.
	const collector = headings
		? [[remarkHeadings, typeof headings === 'object' ? headings : {}]]
		: [];

	const mdsvex_opts: MdsvexOptions = {
		extensions: exts,
		remarkPlugins: [
			...(headingIds ? [remarkHeadingId] : []),
			...collector,
			// Content-hash code ids run AFTER the heading collector (so headings carry scoped ids) and
			// BEFORE mdsvex's own highlight pass, stashing each id on `code.meta` for the highlighter.
			...(codeIds ? [remarkCodeIds] : []),
			// Always collect links into `metadata.links` — the substrate for pharos's link audit.
			remarkLinks,
			...(remarkPlugins ?? [])
		] as MdsvexOptions['remarkPlugins'],
		highlight: {
			highlighter: create_mdsvex_highlighter(cfg)
		}
	};

	const rehype: NonNullable<MdsvexOptions['rehypePlugins']> = [
		...(override_tags.length ? [[rehypeOverrides, override_tags]] : []),
		...(rehypePlugins ?? []),
		// LAST so the anchor `<a>` it adds isn't swept into the pharos slot by `rehypeOverrides`.
		...(headingAnchors ? [rehypeHeadingAnchors] : [])
	] as NonNullable<MdsvexOptions['rehypePlugins']>;
	if (rehype.length) mdsvex_opts.rehypePlugins = rehype;
	if (layout !== undefined) mdsvex_opts.layout = layout;

	// Construct mdsvex lazily and once. The config above needs no mdsvex; only the instance does.
	let md_p: Promise<PreprocessorGroup> | null = null;
	const get_md = (): Promise<PreprocessorGroup> =>
		(md_p ??= load_mdsvex().then((mdsvex) => mdsvex(mdsvex_opts) as PreprocessorGroup));

	// Compose ogygia's marked-import transform AFTER mdsvex so islands authored inside `.svx` / `.md`
	// (`import X from '…' with { wake | render | region }`) become real islands. It runs on the
	// clean svelte mdsvex produces. No-op if `ogygia` isn't installed (plain content app).
	const group: PreprocessorGroup = {
		name: 'ogygia-markdown',
		async markup(input: { content: string; filename: string }) {
			// This hook also runs on every `.svelte` (which must be left untouched). Compute the
			// content-file check up front so the VitePress `:::` container pass only touches `.svx`/`.md`.
			const path = input.filename.split('?')[0];
			const isContent = exts.some((x) => path.endsWith(x));
			// Tab groups first (they emit `:::`-free `<TabGroup>`/`<Tab>`), then admonition containers.
			let raw = input.content;
			let inject_tabs = false;
			if (isContent) {
				if (tabs) {
					const t = transform_tabs(raw);
					raw = t.code;
					// Only inject when the author hasn't already imported TabGroup. Match a real import STATEMENT
					// (line-anchored, `import … TabGroup … from`), so prose like "the ability to import …" pairing
					// with the injected `<TabGroup>` tag can't be mistaken for an existing import.
					inject_tabs = t.used && !/^\s*import\b[^\n]*\bTab(?:Group)?\b[^\n]*\bfrom\b/m.test(raw);
				}
				if (containers) raw = transform_containers(raw);
			}
			const md = await get_md();
			const out = await md.markup?.(raw === input.content ? input : { ...input, content: raw });
			const code = markup_code(out, raw);
			const islandCode = transform_islands(code, input.filename);
			// Source injection is for CONTENT files only (`.svx` / `.md`); mdsvex no-ops on non-content.
			if (islandCode == null && !isContent) return out ?? undefined;
			const base = islandCode ?? code;
			if (!isContent) return { code: base, map: undefined };
			// Content module: carry its raw source, and (when overrides are on) import the slot the
			// rehype pass rewrote tags into. Both are module-script lines injected once.
			const lines: string[] = [];
			const src = source_line(input.filename);
			if (src) lines.push(src);
			if (override_tags.length) lines.push(`import ${SLOT_TAG} from 'ogygia/pharos/slot';`);
			// `:::` tab syntax with no author import → inject the pair (zero-import authoring). Plain barrel
			// import: TabGroup is a plain OVERRIDABLE wrapper; its internal island carries the `wake`.
			if (inject_tabs) lines.push(`import { TabGroup, Tab } from 'ogygia/pharos';`);
			return { code: inject_module(base, lines), map: undefined };
		}
	};

	// Give ogygia a way to discover content-page islands at build time (its own scan can't read
	// markdown). Registered SYNCHRONOUSLY here — set before the plugin's buildStart reads it — and
	// running the SAME markup pipeline as a real compile, so tab-minted islands register too.
	register_island_scanner(
		(content, filename) => Promise.resolve(group.markup?.({ content, filename })),
		exts
	);

	return group;
}

ogygiaPreprocess.extensions = extensions;
