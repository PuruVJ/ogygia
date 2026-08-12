/**
 * Shiki highlighter — server-only (`.server.ts`). Never import from client islands.
 *
 * Lazy: `shiki` loads on first `highlight()` call only. Docs snippets are baked via
 * `prerender()` + `dynamic: true`, so the happy path never enters this module at request time.
 *
 * Themes: custom `ogygia-light` / `ogygia-dark` (site palette), dual via `light-dark()` so
 * `color-scheme` from `app.css` picks the right tokens.
 */
import type { BundledLanguage } from 'shiki';
import { load_ogygia_themes, THEME_REV } from './shiki-themes.js';

type Highlighter = Awaited<ReturnType<(typeof import('shiki'))['createHighlighter']>>;

let highlighter_p: Promise<Highlighter> | null = null;
let highlighter_rev = -1;

function get_highlighter() {
	if (highlighter_rev !== THEME_REV) {
		highlighter_p = null;
		highlighter_rev = THEME_REV;
	}
	return (highlighter_p ??= Promise.all([import('shiki'), load_ogygia_themes()]).then(
		([{ createHighlighter }, themes]) =>
			createHighlighter({
				themes: [themes.light, themes.dark],
				langs: ['svelte', 'typescript', 'javascript', 'html', 'css', 'bash', 'json']
			})
	));
}

export async function highlight(code: string, lang: BundledLanguage | string = 'typescript') {
	const highlighter = await get_highlighter();
	return highlighter.codeToHtml(code.replace(/^\n/, '').replace(/\n$/, ''), {
		lang,
		themes: {
			light: 'ogygia-light',
			dark: 'ogygia-dark'
		},
		// Follows `color-scheme` from app.css (system light/dark).
		defaultColor: 'light-dark()'
	});
}
