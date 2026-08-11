const ESCAPE_BACKSLASH = /\\/g;
const ESCAPE_BACKTICK = /`/g;
const ESCAPE_INTERPOLATION = /\$\{/g;
const LEADING_LF = /^\n/;
const TRAILING_LF = /\n$/;

/**
 * Shiki dual-theme highlighter for markdown fences + remotes.
 * Server/preprocess only — never import from client islands.
 */

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
};

const DEFAULT_LANGS = [
	'svelte',
	'typescript',
	'javascript',
	'html',
	'css',
	'bash',
	'json',
	'yaml',
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
		defaultColor: options.defaultColor === undefined ? DEFAULT_COLOR : options.defaultColor
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

/**
 * Highlight a code string. Uses the config from the last {@link configure_shiki} /
 * {@link markdown} call, or pass options explicitly.
 */
export async function highlight(
	code: string,
	lang: string = 'typescript',
	options?: MarkdownShikiOptions
) {
	const cfg = options ? normalize_shiki(options) : active;
	if (!cfg) {
		throw new Error(
			'[ogygia/content/markdown] highlight() needs markdown() in svelte.config, or pass options as the third argument'
		);
	}
	const highlighter = await get_highlighter(cfg);
	return highlighter.codeToHtml(code.replace(LEADING_LF, '').replace(TRAILING_LF, ''), {
		lang,
		themes: {
			light: cfg.lightName,
			dark: cfg.darkName
		},
		defaultColor: cfg.defaultColor === false ? undefined : cfg.defaultColor
	});
}

/** mdsvex `highlight.highlighter` — fences stay normal ``` in `.svx` / `.md`. */
export function create_mdsvex_highlighter(cfg: ResolvedShiki) {
	return async function content_mdsvex_highlighter(code: string, lang: string | undefined) {
		const html = await highlight(code, lang || 'text', {
			themes: cfg.themes,
			langs: cfg.langs,
			wrapperClass: false,
			defaultColor: cfg.defaultColor
		});
		const wrapped = wrap_html(html, cfg.wrapperClass);
		return `{@html \`${escape_svelte(wrapped)}\`}`;
	};
}
