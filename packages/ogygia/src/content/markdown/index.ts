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
import { islandBridge, content_css_key } from '../../vite/island-bridge.js';
import { BuildCache } from '../../build-cache.js';
import { RegionStore } from '../region-store.js';
import { remarkHeadingId } from './remark-heading-id.js';
import { remarkHeadings, type RemarkHeadingsOptions } from './remark-headings.js';
import { remarkLinks } from './remark-links.js';
import { remarkCodeIds } from './remark-code-ids.js';
import { transform_containers } from './containers.js';
import { transform_tabs } from './tabs.js';
import { rehypeHeadingAnchors } from './rehype-heading-anchors.js';
import { parse_yaml } from './frontmatter.js';
import { try_region_emit } from './region-emit.js';
import { DEFAULT_OVERRIDE_TAGS, rehypeOverrides, SLOT_TAG } from './rehype-overrides.js';
import {
	configure_shiki,
	create_mdsvex_highlighter,
	type MarkdownShikiOptions,
	type MarkdownThemePair
} from './shiki.js';

export type { MarkdownShikiOptions, MarkdownThemePair, RemarkHeadingsOptions };
import type { ShikiTransformer } from 'shiki';
import type { MetaParser, VariantGenerator } from './code.js';
import { default_pipeline } from './code-render.js';
export { infostring, slash_meta } from './code.js';
export { diff_markers } from './diff.js';
export { inline_markers } from './inline-markers.js';
export type { InlineMarkerOptions } from './inline-markers.js';
export type { Fence, MetaParser, VariantGenerator, Variant } from './code.js';

/**
 * The CODE fence pipeline config — one bag for the whole fence dialect. Core knows CONTRACTS, not
 * features: each slot takes imported adapter VALUES, never feature flags. (Stages `meta` and
 * `variants` arrive in later steps; `transformers` is the Shiki decoration contract.)
 */
export type CodeOptions = {
	/** Shiki transformers applied to every fence — diff/focus/highlight, twoslash, or your own. */
	transformers?: ShikiTransformer[];
	/** Fence-meta parsers (LAYER). Default `[infostring()]`; add `slash_meta()` for `/// file:` etc. */
	meta?: MetaParser[];
	/** Variant generators (RACE) — one authored fence → N switchable versions (a JS↔TS converter,
	 *  package-manager tabs, …). App-authored values; core ships the contract, not the features. */
	variants?: VariantGenerator[];
	/**
	 * Folded into the fence-cache address. The cache identifies stages by NAME (transformers) /
	 * preference + `cache_key` (variants) — editing a stage's BEHAVIOR without renaming it is
	 * invisible, so bump this (or version the stage's name) while iterating on custom stages.
	 */
	cacheSalt?: string;
};
export type { Heading } from '../index.js';
export { highlight, escape_svelte, wrap_html, normalize_shiki } from './shiki.js';
export { remarkHeadingId } from './remark-heading-id.js';
export { remarkHeadings, slugify } from './remark-headings.js';
export { remarkLinks } from './remark-links.js';
export { parseFrontmatter } from './frontmatter.js';
export type { FrontmatterResult } from './frontmatter.js';

/** One unified plugin entry (a plugin, or a `[plugin, options]` tuple), as mdsvex accepts them. */
type UnifiedEntry = NonNullable<MdsvexOptions['remarkPlugins']>[number];
/**
 * A prose/rehype chain entry, optionally staged Vite-style: a plain entry runs in the default slot;
 * `{ enforce: 'pre', plugin }` runs before the built-in passes (`'post'` = the default, explicit).
 */
export type StagedPlugin =
	| UnifiedEntry
	| {
			enforce: 'pre' | 'post';
			plugin: UnifiedEntry;
			/**
			 * Cache identity for a GENERATOR plugin whose output depends on inputs OUTSIDE the document
			 * (a `.d.ts` set, a data file). Functions can't be hashed, so without this a doc that expands
			 * a directive caches on (document, config) alone and goes STALE when the generator's inputs
			 * change. Return a value that changes when the generated output would — a content/mtime hash
			 * of the inputs. Read on every compile (memoize inside; keep it cheap). Same contract the
			 * variant generators' `cache_key` already carries.
			 */
			cache_key?: () => string;
			/**
			 * Files (absolute paths) whose edits should recompile a document this plugin touched —
			 * threaded into the preprocessor's returned `dependencies`, which vite-plugin-svelte watches
			 * in dev. Called with the document's filename after each compile; return `[]` when the doc
			 * used none. Dependency lists ride the doc cache too, so a warm hit still watches.
			 */
			dependencies?: (filename: string) => string[];
	  };

/** Split a staged chain into pre/post halves + the generator hooks (cache identity, file deps). */
function split_staged(list: Array<StagedPlugin> | undefined): {
	pre: UnifiedEntry[];
	post: UnifiedEntry[];
	cache_keys: Array<() => string>;
	deps: Array<(filename: string) => string[]>;
} {
	const pre: UnifiedEntry[] = [];
	const post: UnifiedEntry[] = [];
	const cache_keys: Array<() => string> = [];
	const deps: Array<(filename: string) => string[]> = [];
	for (const e of list ?? []) {
		if (e && typeof e === 'object' && !Array.isArray(e) && 'plugin' in e) {
			(e.enforce === 'pre' ? pre : post).push(e.plugin);
			if (typeof e.cache_key === 'function') cache_keys.push(e.cache_key);
			if (typeof e.dependencies === 'function') deps.push(e.dependencies);
		} else {
			post.push(e as UnifiedEntry);
		}
	}
	return { pre, post, cache_keys, deps };
}

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
	 * Wrap overridable markdown elements in the ogygia slot so an ogygia site's `components` map can
	 * replace how they render (id-form links, optimized images, custom code, …). `true` uses the
	 * default tag set (`a`, `img`, `code`); pass `{ tags }` to widen. Off by default — a non-ogygia
	 * content app must not carry the slot. The component VALUES live in `site()`, never here.
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
	/**
	 * The PROSE DIALECT contract — extra remark plugins (unified ecosystem values: `remark-math`,
	 * mermaid, an include/type-docs expander, …). Core ships none by default.
	 *
	 * A plain entry runs AFTER the built-in passes (heading ids, heading + link collection, code
	 * ids) — the common case. An entry may instead declare its stage Vite-style:
	 * `{ enforce: 'pre', plugin }` runs BEFORE every built-in, so content it GENERATES (an expanded
	 * directive's headings + fences) flows through the TOC collectors, code ids, and the link audit
	 * exactly as if hand-authored. `enforce: 'post'` is the explicit spelling of the default.
	 */
	remark?: Array<StagedPlugin>;
	/** Extra rehype plugins — same staging contract as {@link MarkdownOptions.remark}: plain entries
	 *  run after the ogygia override wrap (before heading anchors); `{ enforce: 'pre', plugin }` runs
	 *  before the wrap. */
	rehype?: Array<StagedPlugin>;
	/** The fence pipeline — `{ transformers, … }`. See {@link CodeOptions}. */
	code?: CodeOptions;
	/** Override extensions (default `.svx` / `.md`). */
	extensions?: string[];
	/** Forwarded to mdsvex `layout`. */
	layout?: MdsvexOptions['layout'];
	/**
	 * Compile pure-static `.md` files to **serialized regions**: the whole document becomes one plain
	 * HTML string in the module script (`__ogygia_region`), the template a single `{@html}` reference —
	 * content crosses into Svelte as DATA, never as template source. Bodies arrive pre-baked (awaiting
	 * them is a no-op) and the escaping hazard class is structurally gone. A file that is NOT pure
	 * static (islands, `<script>`, component tags, svelte expressions, tabs) keeps the component path
	 * automatically — `.svx` always does. Default `false` (flip-on per app while it bakes).
	 */
	region?: boolean;
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
			'[ogygia/content] Markdown content needs the optional peer dependency "mdsvex". Install it:\n' +
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
		// Fresh each scan (dev re-scan / build) — a stale file must not keep emitting CSS.
		islandBridge.contentStyleSources.clear();
		for (const file of files) {
			const raw = readFile(file);
			if (raw == null) continue;
			// The FULL markup pipeline of a real compile — `:::` tab rewrite + island import injection
			// → mdsvex → island transform (which registers). Running only mdsvex here would miss the
			// islands the tab pass mints, so their client chunks would never be emitted at build.
			const res = await run_markup(raw, file);
			// A content module's OWN scoped `<style>` compiles into the SERVER bundle only (the leak-free
			// corpus never enters the client graph), so record its post-mdsvex source — the plugin's
			// client leg svelte-compiles it to extract the scoped CSS and emits it as a client asset,
			// keyed by content_css_key. Same `<style>` detector the compile uses to bake `__ogygia_css`,
			// so emit side and render side agree on which files carry content CSS.
			if (raw.includes('<style') && res && typeof (res as { code?: unknown }).code === 'string')
				islandBridge.contentStyleSources.set(file, (res as { code: string }).code);
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
		remark = [],
		rehype: rehypeExtra,
		code,
		extensions: exts = [...extensions],
		layout,
		region: region_mode = false,
		...shiki_opts
	} = options ?? (islandBridge.markdownConfig as MarkdownOptions | null) ?? {};

	// Element overrides: which tags get wrapped in the ogygia slot (values live in `site()`).
	const override_tags = overrides ? (overrides === true ? [...DEFAULT_OVERRIDE_TAGS] : (overrides.tags ?? [...DEFAULT_OVERRIDE_TAGS])) : [];

	// The fence pipeline's transformers ride the shiki config (applied at codeToHtml).
	const cfg = configure_shiki({ ...shiki_opts, ...(code?.transformers ? { transformers: code.transformers } : {}) });
	// meta parsers (default infostring) + variant generators — the meta/variants stages.
	const pipeline = {
		meta: code?.meta ?? default_pipeline().meta,
		variants: code?.variants ?? []
	};

	// heading-id (explicit `{#id}`) must run before the collector so explicit ids win.
	// Passed as `[attacher, options]` (unified/mdsvex plugin form), not called.
	const collector = headings
		? [[remarkHeadings, typeof headings === 'object' ? headings : {}]]
		: [];

	const remark_staged = split_staged(remark);
	const rehype_staged = split_staged(rehypeExtra);

	// ── the DOC-LEVEL cache ────────────────────────────────────────────────────────
	// The whole markup() stage — tabs/containers → mdsvex (remark/rehype/fences/twoslash) → island
	// transform → region emit — is a pure function of (file content, this configuration). Cache the
	// OUTPUT per content file, content-addressed like the fence cache one level down: a hit skips
	// everything, which is what makes the first dev request O(cache-reads) instead of O(recompile),
	// and a `node_modules`-cached CI build recompile-free. Alongside it, `regions` stores each
	// region-emitted document's serialized `{ html }` — content as data-with-an-address, the artifact
	// future layers (incremental builds, edge, on-demand baking) consume directly.
	// Stage identity: functions can't be hashed — plugins/transformers count by NAME/count, and
	// `code.cacheSalt` is the documented bump for behavior edits (same contract as the fence cache).
	const doc_cache = new BuildCache<{ code: string; deps?: string[] }>('markup');
	// The document REGION rides ogygia's core RegionStore — markdown is one producer harnessing the
	// shared currency, not the owner of a private format. Same address as the module-code entry.
	const docs_store = new RegionStore('docs');
	const doc_sig = () =>
		[
			'v1', // markup-cache format
			String(region_mode),
			String(headingIds),
			JSON.stringify(headings),
			JSON.stringify(override_tags),
			String(containers),
			String(tabs),
			String(headingAnchors),
			String(codeIds),
			`r${remark_staged.pre.length}.${remark_staged.post.length}`,
			// generator-plugin cache identities (a directive expander over a .d.ts set, …) — dynamic, so
			// an input edit re-keys every doc that could have expanded it (read late, like the variants)
			[...remark_staged.cache_keys, ...rehype_staged.cache_keys].map((k) => k()).join(","),
			`h${rehype_staged.pre.length}.${rehype_staged.post.length}`,
			cfg.lightName,
			cfg.darkName,
			String(cfg.defaultColor),
			String(cfg.wrapperClass),
			cfg.transformers.map((t) => t.name ?? '?').join(','),
			`m${pipeline.meta.length}`,
			// variant cache_keys are dynamic (a getter that includes the loaded TS version) — read late
			pipeline.variants.map((g) => g.pref.name + ':' + (g.cache_key ?? '')).join(','),
			code?.cacheSalt ?? ''
		].join('\0');

	const mdsvex_opts: MdsvexOptions = {
		extensions: exts,
		remarkPlugins: [
			// `enforce: 'pre'` entries FIRST — content they generate (an expanded type-docs directive's
			// headings + fences) flows through the built-ins below exactly as if hand-authored.
			...remark_staged.pre,
			...(headingIds ? [remarkHeadingId] : []),
			...collector,
			// Content-hash code ids run AFTER the heading collector (so headings carry scoped ids) and
			// BEFORE mdsvex's own highlight pass, stashing each id on `code.meta` for the highlighter.
			...(codeIds ? [remarkCodeIds] : []),
			// Always collect links into `metadata.links` — the substrate for ogygia's link audit.
			remarkLinks,
			...remark_staged.post
		] as MdsvexOptions['remarkPlugins'],
		highlight: {
			highlighter: create_mdsvex_highlighter(cfg, pipeline, code?.cacheSalt)
		},
		// Use OUR frontmatter parser, not mdsvex's default js-yaml. It's a frontmatter parser first and
		// a YAML parser second: a brace-wrapped title like `{@const}` / `{#each}` (Svelte docs source)
		// stays the STRING it looks like instead of parsing to a `{ '@const': null }` object. mdsvex
		// hands `parse` the text between the `---` fences; a top-level sequence/scalar coerces to `{}`.
		frontmatter: {
			type: 'yaml',
			marker: '-',
			parse: (fm: string) => {
				const data = parse_yaml(fm);
				return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
			}
		}
	};

	const rehype_chain: NonNullable<MdsvexOptions['rehypePlugins']> = [
		...rehype_staged.pre,
		...(override_tags.length ? [[rehypeOverrides, override_tags]] : []),
		...rehype_staged.post,
		// LAST so the anchor `<a>` it adds isn't swept into the ogygia slot by `rehypeOverrides`.
		...(headingAnchors ? [rehypeHeadingAnchors] : [])
	] as NonNullable<MdsvexOptions['rehypePlugins']>;
	if (rehype_chain.length) mdsvex_opts.rehypePlugins = rehype_chain;
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

			// Doc-level cache: content files only. The variant generators' `cache_key` includes lazily
			// loaded identity (the TS compiler version), so settle their `ready()` BEFORE keying — a key
			// taken pre-load would give the same doc a second address on the next run.
			let doc_key: string | null = null;
			if (isContent) {
				await Promise.all(pipeline.variants.map((g) => g.ready?.()));
				const base_name = path.replace(/\\/g, '/').split('/').pop() ?? '';
				doc_key = docs_store.key([doc_sig(), base_name, input.content]);
				const hit = doc_cache.get(doc_key);
				if (hit) return { code: hit.code, map: undefined, dependencies: hit.deps };
			}
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
			// OWNERSHIP RULE (load-bearing): the island transform runs here for CONTENT files ONLY.
			// Islands in a `.svelte` belong to the Vite plugin's transform hook, which runs BEFORE
			// vite-plugin-svelte and therefore before this markup hook. Running the bridge on a
			// `.svelte` here means transforming the plugin's OUTPUT — the marked import is already
			// rewritten, so a server island reads as a plain component and its `{#snippet}` children
			// get branded as phantom portable snippets, whose registration then WIPES the host's real
			// wrapper registrations (the csr=false + `render:'deferred'` prerender crash).
			if (!isContent) return undefined;
			const md = await get_md();
			const out = await md.markup?.(raw === input.content ? input : { ...input, content: raw });
			const code = markup_code(out, raw);
			const islandCode = transform_islands(code, input.filename);
			const base = islandCode ?? code;
			// Generator-plugin file deps for THIS document (a directive expander's .d.ts set, …) —
			// returned as preprocessor `dependencies` (vite-plugin-svelte watches them in dev) and
			// stored beside the cached output so a warm hit still watches.
			const gen_deps = [...remark_staged.deps, ...rehype_staged.deps].flatMap((fn) => fn(input.filename));
			// Content module: carry its raw source, and (when overrides are on) import the slot the
			// rehype pass rewrote tags into. Both are module-script lines injected once.
			const lines: string[] = [];
			const src = source_line(input.filename);
			if (src) lines.push(src);
			// Bake the CSS key when the module carries its own scoped `<style>`. markdown_format reads
			// `__ogygia_css` onto the body region so Region.svelte can link the client CSS chunk the
			// plugin emits for this file. content_css_key(abs) is the SAME key the emit + handoff use
			// (derived from the absolute path on both sides), so they match without threading `root`.
			// `<style>` detector mirrors the scanner's contentStyleFiles filter → emit and render agree.
			if (input.content.includes('<style'))
				lines.push(`export const __ogygia_css = ${JSON.stringify(content_css_key(path))};`);
			// REGION path: a pure-static `.md` re-emits as a serialized region — content as data, one
			// `{@html}` reference in the template, body pre-baked. Only when nothing dynamic touched the
			// file: no island transform, no tab injection, no slot overrides; the emitter itself vetoes
			// scripts / component tags / svelte expressions and falls back to the component path.
			if (region_mode && path.endsWith('.md') && islandCode == null && !inject_tabs && !override_tags.length) {
				const emitted = try_region_emit(base, lines);
				if (emitted) {
					// Store BOTH artifacts: the compiled module (next compile is a read), and the
					// serialized region itself — the address future layers (incremental builds, edge,
					// on-demand baking) fetch without ever seeing a module.
					if (doc_key) {
						doc_cache.set(doc_key, { code: emitted.code, ...(gen_deps.length ? { deps: gen_deps } : {}) });
						docs_store.set(doc_key, { html: emitted.html });
					}
					return { code: emitted.code, map: undefined, dependencies: gen_deps };
				}
			}
			if (override_tags.length) lines.push(`import ${SLOT_TAG} from 'ogygia/content/slot';`);
			// `:::` tab syntax with no author import → inject the pair (zero-import authoring). Plain barrel
			// import: TabGroup is a plain OVERRIDABLE wrapper; its internal island carries the `wake`.
			if (inject_tabs) lines.push(`import { TabGroup, Tab } from 'ogygia/content';`);
			const compiled = inject_module(base, lines);
			// Cache ONLY island-free outputs: transforming an island REGISTERS it (a build-time side
			// effect the scanner needs) — a cached hit would skip that, so island-carrying files pay
			// their compile every time. Everything a hit returns is side-effect-free by construction.
			if (doc_key && islandCode == null)
				doc_cache.set(doc_key, { code: compiled, ...(gen_deps.length ? { deps: gen_deps } : {}) });
			return { code: compiled, map: undefined, dependencies: gen_deps };
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

/**
 * The end-of-file marker the ogygia plugin appends to a content-preset module VARIANT
 * (`file.svx?og_preset=name`). vite-plugin-svelte strips the query from the `filename` a
 * preprocessor sees, so the preset name travels in CONTENT instead: the dispatcher below reads it,
 * strips it, and routes to the preset's pipeline — mdsvex never sees the marker.
 */
const PRESET_MARKER_RE = /\n?<!--og_preset:([\w-]+)-->\s*$/;

/**
 * The preset-aware preprocessor `ogygia.preprocess()` mounts. Without content presets it IS the
 * plain {@link ogygiaPreprocess} (zero regression). With presets, it dispatches per file: an
 * unmarked file compiles through the default pipeline; a `?og_preset=` variant (marker-tagged by
 * the plugin) compiles through a lazily-built pipeline whose config is the preset's bag merged
 * over the defaults — depth-2, per setting key. One file under two presets = two variants = two
 * independent compiles; caches stay distinct because each pipeline's config signature differs.
 */
export function ogygiaPresetPreprocess(): PreprocessorGroup {
	// The default pipeline is built EAGERLY — its island scanner registration must win (the
	// buildStart scan reads files from disk, where no variant marker exists, so it scans with the
	// default config by design). Preset pipelines are built lazily and must NOT clobber the scanner.
	const default_group = ogygiaPreprocess();
	if (!islandBridge.contentPresets) return default_group;
	const default_scan = islandBridge.scan;

	const groups = new Map<string, PreprocessorGroup>();
	const group_for = (preset: string): PreprocessorGroup => {
		let g = groups.get(preset);
		if (!g) {
			const bag = islandBridge.contentPresets?.[preset];
			if (!bag) {
				throw new Error(
					`[ogygia/content] unknown content preset '${preset}' on a module variant. Configured: ${Object.keys(islandBridge.contentPresets ?? {}).join(', ') || '(none)'}.`
				);
			}
			const base = (islandBridge.markdownConfig as MarkdownOptions | null) ?? {};
			g = ogygiaPreprocess({ ...base, ...(bag.markdown ?? {}) } as MarkdownOptions);
			islandBridge.scan = default_scan; // the preset pipeline registered itself — undo; default owns scan
			groups.set(preset, g);
		}
		return g;
	};

	return {
		name: 'ogygia-markdown',
		async markup(input: { content: string; filename: string }) {
			const m = PRESET_MARKER_RE.exec(input.content);
			if (!m) return default_group.markup?.(input);
			return group_for(m[1]).markup?.({ ...input, content: input.content.slice(0, m.index) });
		}
	};
}

