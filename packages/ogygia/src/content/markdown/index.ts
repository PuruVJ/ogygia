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

import { mdsvex, type MdsvexOptions } from 'mdsvex';
import { islandBridge } from '../../vite/island-bridge.js';
import { remarkHeadingId } from './remark-heading-id.js';
import { remarkHeadings, type RemarkHeadingsOptions } from './remark-headings.js';
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
	/** Extra remark plugins (after heading-id / heading collection). */
	remarkPlugins?: MdsvexOptions['remarkPlugins'];
	/** Extra rehype plugins. */
	rehypePlugins?: MdsvexOptions['rehypePlugins'];
	/** Override extensions (default `.svx` / `.md`). */
	extensions?: string[];
	/** Forwarded to mdsvex `layout`. */
	layout?: MdsvexOptions['layout'];
};

/** Rewrite marked island imports in already-mdsvex'd Svelte via the plugin's in-process bridge
 *  (the plugin owns `transform`; we register `scan`). No-op when the ogygia plugin isn't active. */
function transform_islands(content: string, filename: string): string | null {
	return islandBridge.transform ? islandBridge.transform(content, filename) : null;
}

/**
 * Register a build-time island scanner on the bridge so islands authored inside `.svx` / `.md`
 * content get their client chunks emitted. ogygia's own scan (in `buildStart`) reads only
 * `.svelte` / `.ts`; a content page becomes Svelte only after mdsvex, which is our job. The scanner
 * walks `src` for the configured extensions, runs mdsvex, and registers each via
 * {@link transform_islands}. Set synchronously at config time — always before `buildStart` reads it.
 */
function register_island_scanner(md: ReturnType<typeof mdsvex>, exts: readonly string[]): void {
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
			// Same pipeline as a real compile: mdsvex → island transform (which registers).
			const out = await md.markup?.({ content: raw, filename: file });
			transform_islands(out?.code ?? raw, file);
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
 * extensions: ['.svelte', ...ogygiaPreprocess.extensions],
 * preprocess: [vitePreprocess(), ogygiaPreprocess()],
 * ```
 *
 * Pass options directly to override (`ogygiaPreprocess({ themes })`).
 */
export function ogygiaPreprocess(options?: MarkdownOptions): ReturnType<typeof mdsvex> {
	const {
		headingIds = true,
		headings = true,
		remarkPlugins = [],
		rehypePlugins,
		extensions: exts = [...extensions],
		layout,
		...shiki_opts
	} = options ?? (islandBridge.markdownConfig as MarkdownOptions | null) ?? {};

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
			...(remarkPlugins ?? [])
		] as MdsvexOptions['remarkPlugins'],
		highlight: {
			highlighter: create_mdsvex_highlighter(cfg)
		}
	};

	if (rehypePlugins) mdsvex_opts.rehypePlugins = rehypePlugins;
	if (layout !== undefined) mdsvex_opts.layout = layout;

	const md = mdsvex(mdsvex_opts);

	// Give ogygia a way to discover content-page islands at build time (its own scan can't read
	// markdown). Registered SYNCHRONOUSLY at config time — set before the plugin's buildStart reads it.
	register_island_scanner(md, exts);

	// Compose ogygia's marked-import transform AFTER mdsvex so islands authored inside `.svx` / `.md`
	// (`import X from '…' with { wake | render | region }`) become real islands. It runs on the
	// clean svelte mdsvex produces. No-op if `ogygia` isn't installed (plain content app).
	return {
		...md,
		name: 'ogygia-markdown',
		async markup(input: { content: string; filename: string }) {
			const out = await md.markup?.(input);
			const code = out?.code ?? input.content;
			const islandCode = transform_islands(code, input.filename);
			if (islandCode == null) return out;
			// Drop mdsvex's map — the island rewrite invalidates it (dev sourcemap only).
			return { ...out, code: islandCode, map: undefined };
		}
	} as ReturnType<typeof mdsvex>;
}

ogygiaPreprocess.extensions = extensions;
