const ESCAPE_BACKSLASH = /\\/g;
const ESCAPE_BACKTICK = /`/g;
const ESCAPE_INTERPOLATION = /\$\{/g;
const LEADING_LF = /^\n/;
const TRAILING_LF = /\n$/;

/**
 * Shiki dual-theme highlighter for markdown fences + remotes.
 * Server/preprocess only — never import from client islands.
 */

import type { ShikiTransformer } from 'shiki';
import { render_fence, default_pipeline, type CodePipeline } from './code-render.js';
import { fence_key, fence_cache_get, fence_cache_set } from './fence-cache.js';
import type { SerializedRegion } from '../region-store.js';

/** A Shiki bundled theme name, or a theme object (e.g. `ThemeRegistrationResolved`). */
export type MarkdownThemeInput = string | { name?: string };

export type MarkdownThemePair = {
	light: MarkdownThemeInput;
	dark: MarkdownThemeInput;
};

export type MarkdownShikiOptions = {
	/**
	 * Dual themes for light/dark (default: `github-light` / `github-dark`).
	 * Pass Shiki bundled theme names or full theme objects.
	 */
	themes?: MarkdownThemePair;
	/** Languages to preload (default: svelte/ts/js/html/css/bash/json/yaml/text). */
	langs?: string[];
	/**
	 * Class on the wrapper around Shiki HTML (default `'code-only'`).
	 * Pass `false` for bare Shiki output.
	 */
	wrapperClass?: string | false;
	/**
	 * Shiki `defaultColor` (default `'light-dark()'` so `color-scheme` picks tokens).
	 */
	defaultColor?: string | false;
	/**
	 * Shiki TRANSFORMERS — the ecosystem's highlight-decoration contract (`@shikijs/transformers`
	 * for diff/focus/highlight, `@shikijs/twoslash` for typed hovers, or your own). Applied to every
	 * fence at `codeToHtml`. Core ships none; svelte.dev's inline `+++`/`---` markers are one custom
	 * transformer value.
	 */
	transformers?: ShikiTransformer[];
};

// A generous docs-friendly default. Highlighting runs at BUILD time (SSR) producing static HTML — the
// client ships zero Shiki — so loading many grammars costs nothing at runtime. Each canonical language
// also registers its Shiki aliases, so ```md, ```sh, ```ts, ```js, ```yml, ```console, … all resolve.
const DEFAULT_LANGS = [
	// web / svelte
	'svelte',
	'typescript', // ts
	'javascript', // js
	'jsx',
	'tsx',
	'html',
	'css',
	'scss',
	'sass',
	'less',
	'vue',
	'astro',
	// data / config
	'json',
	'jsonc',
	'json5',
	'yaml', // yml
	'toml',
	'ini',
	'xml',
	'graphql', // gql
	'sql',
	// shell / diff / docker
	'bash', // sh, shell, zsh
	'shellsession', // console
	'powershell', // ps, ps1
	'diff',
	'docker', // dockerfile
	'make',
	'nginx',
	// prose
	'markdown', // md
	'mdx',
	// general-purpose
	'python', // py
	'rust', // rs
	'go',
	'ruby', // rb
	'php',
	'java',
	'kotlin',
	'c',
	'cpp',
	'csharp', // cs, c#
	'swift',
	'text'
] as const;

const DEFAULT_WRAPPER = 'code-only';
const DEFAULT_COLOR = 'light-dark()';
const DEFAULT_THEMES: MarkdownThemePair = {
	light: 'github-light',
	dark: 'github-dark'
};

type Highlighter = Awaited<ReturnType<(typeof import('shiki'))['createHighlighter']>>;

export type ResolvedShiki = {
	themes: MarkdownThemePair;
	lightName: string;
	darkName: string;
	langs: string[];
	wrapperClass: string | false;
	defaultColor: string | false;
	transformers: ShikiTransformer[];
};

let active: ResolvedShiki | null = null;
let highlighter_p: Promise<Highlighter> | null = null;
let highlighter_key = '';

export function normalize_shiki(options: MarkdownShikiOptions = {}): ResolvedShiki {
	const themes = options.themes ?? DEFAULT_THEMES;
	const lightName =
		typeof themes.light === 'string' ? themes.light : String((themes.light as { name?: string }).name ?? 'light');
	const darkName =
		typeof themes.dark === 'string' ? themes.dark : String((themes.dark as { name?: string }).name ?? 'dark');

	return {
		themes,
		lightName,
		darkName,
		langs: [...(options.langs ?? DEFAULT_LANGS)],
		wrapperClass: options.wrapperClass === undefined ? DEFAULT_WRAPPER : options.wrapperClass,
		defaultColor: options.defaultColor === undefined ? DEFAULT_COLOR : options.defaultColor,
		transformers: options.transformers ?? []
	};
}

export function configure_shiki(options: MarkdownShikiOptions = {}) {
	active = normalize_shiki(options);
	highlighter_p = null;
	highlighter_key = '';
	return active;
}

export function get_shiki_config() {
	return active;
}

function theme_key(cfg: ResolvedShiki) {
	return `${cfg.lightName}|${cfg.darkName}|${cfg.langs.join(',')}`;
}

function get_highlighter(cfg: ResolvedShiki) {
	const key = theme_key(cfg);
	if (highlighter_key !== key) {
		highlighter_p = null;
		highlighter_key = key;
	}
	return (highlighter_p ??= import('shiki').then(({ createHighlighter }) =>
		createHighlighter({
			themes: [cfg.themes.light as never, cfg.themes.dark as never],
			langs: cfg.langs
		})
	));
}

export function wrap_html(html: string, wrapperClass: string | false) {
	if (!wrapperClass) return html;
	return `<div class="${wrapperClass}">${html}</div>`;
}

/** Escape for embedding inside a Svelte `{@html \`…\`}` template (mdsvex highlighter). */
export function escape_svelte(html: string) {
	return html.replace(ESCAPE_BACKSLASH, '\\\\').replace(ESCAPE_BACKTICK, '\\`').replace(ESCAPE_INTERPOLATION, '\\${');
}

/** Wrap plain fence HTML in the svelte-embeddable form the COMPONENT path needs. The region emitter
 *  reverses this exactly (see `region-emit.ts` `unescape_svelte`) — the pair is a lossless codec. */
export function fence_embed(plain_html: string) {
	return `{@html \`${escape_svelte(plain_html)}\`}`;
}

/**
 * Highlight a code string. Uses the config from the last {@link configure_shiki} /
 * {@link markdown} call, or pass options explicitly.
 */
export async function highlight(
	code: string,
	lang: string = 'typescript',
	options?: MarkdownShikiOptions,
	/** Raw fence infostring — passed to Shiki as `meta.__raw` so meta-reading transformers
	 *  (`transformerMetaHighlight` for `{1-3,5}`, word highlight, `// [!code …]`) can read it. */
	rawMeta?: string
) {
	const cfg = options ? normalize_shiki(options) : active;
	if (!cfg) {
		throw new Error(
			'[ogygia/content] highlight() needs markdown() in svelte.config, or pass options as the third argument'
		);
	}
	const highlighter = await get_highlighter(cfg);
	// An unknown fence language (a `tree` file-listing, a bespoke DSL) must NOT throw — one exotic
	// fence in a large imported corpus would otherwise fail the whole build. Fall back to plain text.
	const loaded = highlighter.getLoadedLanguages();
	const safe_lang =
		lang === 'text' || lang === 'plaintext' || lang === 'txt' || loaded.includes(lang) ? lang : 'text';
	return highlighter.codeToHtml(code.replace(LEADING_LF, '').replace(TRAILING_LF, ''), {
		lang: safe_lang,
		themes: {
			light: cfg.lightName,
			dark: cfg.darkName
		},
		defaultColor: cfg.defaultColor === false ? undefined : cfg.defaultColor,
		...(cfg.transformers.length ? { transformers: cfg.transformers } : {}),
		...(rawMeta ? { meta: { __raw: rawMeta } } : {})
	});
}

/** Pull the `ogygia-code-id=<id>` token that `remarkCodeIds` stashed on the fence meta. Returns the
 *  id (or null) so the highlighter can stamp it onto the `<pre>` — the build-time half of the stable
 *  `slug-code-<hash>` permalink id (see `remark-code-ids.ts`). Matches an unquoted, space-free id. */
function pluck_code_id(meta: string | undefined | null): string | null {
	if (!meta) return null;
	const m = /ogygia-code-id=(\S+)/.exec(meta);
	return m ? m[1]! : null;
}

/** mdsvex `highlight.highlighter` — fences stay normal ``` in `.svx` / `.md`. mdsvex threads the fence
 *  `meta` in as the third argument, which carries the `remarkCodeIds` id token. Runs the fence pipeline
 *  (meta parsers → variants → highlight) when a `pipeline` is given; else the plain single-variant path.
 *  Output is memoized in the content-addressed fence cache (`node_modules/.ogygia/fences`) — Shiki +
 *  variant generation dominate a cold corpus compile and are pure functions of the inputs hashed below. */
/** The config fingerprint that addresses a fence in the cache — everything that shapes output EXCEPT
 *  the per-fence (lang, meta, code). Meta parsers are counted (plain functions); variants contribute
 *  their preference name + `cache_key`; transformers their `name`s. A stage whose BEHAVIOR changes
 *  while its name stays put is invisible here — bump `cacheSalt` (or version the name) while iterating. */
export function fence_config_key(cfg: ResolvedShiki, pipe: CodePipeline, cache_salt = ''): string[] {
	return [
		cache_salt,
		theme_key(cfg),
		String(cfg.defaultColor),
		String(cfg.wrapperClass),
		cfg.transformers.map((t) => t.name ?? '?').join(','),
		`m${pipe.meta.length}`,
		pipe.variants.map((g) => g.pref.name + ':' + (g.cache_key ?? '')).join(',')
	];
}

export function create_mdsvex_highlighter(cfg: ResolvedShiki, pipeline?: CodePipeline, cache_salt = '') {
	const pipe = pipeline ?? default_pipeline();
	const config_key = fence_config_key(cfg, pipe, cache_salt);
	return async function content_mdsvex_highlighter(
		code: string,
		lang: string | undefined,
		meta?: string | null
	) {
		// Render (or hit cache) to a serialized region, then apply the `{@html}` embedding wrap on the
		// way OUT (an mdsvex concern; the region emitter reverses it wholesale). `code()` shares the
		// exact same fence→region step but inlines the `{ html }` directly, no embedding.
		const { html } = await render_code_region(cfg, pipe, config_key, code, lang, meta);
		return fence_embed(html);
	};
}

/**
 * The core fence → SERIALIZED REGION step — shared by the mdsvex highlighter (which then embeds the
 * html) and `import.meta.og.code()` (which inlines the `{ html }` as a prebaked region). Runs the
 * meta/variant/highlight pipeline, stamps `data-lang`/`data-file`/id onto the `<pre>`, and rides the
 * content-addressed fence cache — so the same snippet renders once across a whole build. `config_key`
 * is the config fingerprint (theme, transformers, salt) already assembled by the caller.
 */
export async function render_code_region(
	cfg: ResolvedShiki,
	pipe: CodePipeline,
	config_key: ReadonlyArray<string>,
	code: string,
	lang: string | undefined,
	meta?: string | null
): Promise<SerializedRegion> {
	const key = fence_key([...config_key, lang ?? '', meta ?? '', code]);
	const cached = fence_cache_get(key);
	if (cached != null) return cached;

	// Strip our internal `ogygia-code-id=…` token from the meta before handing the REST to Shiki as
	// `__raw`, so meta transformers (`{1-3,5}` line highlight, word highlight, `// [!code …]`) read
	// the author's infostring without our bookkeeping leaking in.
	const shiki_meta = (meta ?? '').replace(/\s*ogygia-code-id=\S+/, '').trim();
	const hl = (source: string, l: string, rm: string) =>
		highlight(source, l || 'text', { themes: cfg.themes, langs: cfg.langs, wrapperClass: false, defaultColor: cfg.defaultColor, transformers: cfg.transformers }, rm || undefined);

	const { html, count, file } = await render_fence(code, lang || 'text', shiki_meta, pipe, hl);

	const id = pluck_code_id(meta);
	let plain: string;
	if (count > 1) {
		// Multi-variant container: stamp the permalink id on the outer `<div class="og-code">`.
		const tagged = id ? html.replace('<div class="og-code"', `<div id="${id}" class="og-code"`) : html;
		plain = wrap_html(tagged, cfg.wrapperClass);
	} else {
		// Single variant: stamp `data-lang` + id + the pipeline's `file` (chrome draws the filename
		// bar from `attr(data-file)`) on the `<pre>` — a fence with none stays byte-identical.
		let attrs = '';
		if (lang && lang !== 'text') attrs += `data-lang="${lang}" `;
		if (id) attrs += `id="${id}" `;
		if (file) attrs += `data-file="${file.replace(/"/g, '&quot;')}" `;
		const tagged = attrs ? html.replace('<pre ', `<pre ${attrs}`) : html;
		plain = wrap_html(tagged, cfg.wrapperClass);
	}
	const out: SerializedRegion = { html: plain };
	fence_cache_set(key, out);
	return out;
}
