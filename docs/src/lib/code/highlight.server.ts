/**
 * Shiki highlighter — server-only (`.server.ts`). Never import from client islands.
 *
 * Lazy: `shiki` loads on first `highlight()` call only. Docs snippets are baked via
 * `prerender()` + `dynamic: true`, so the happy path never enters this module at request time.
 */
import type { BundledLanguage } from 'shiki';

type Highlighter = Awaited<ReturnType<(typeof import('shiki'))['createHighlighter']>>;

let highlighter_p: Promise<Highlighter> | null = null;

function get_highlighter() {
	return (highlighter_p ??= import('shiki').then(({ createHighlighter }) =>
		createHighlighter({
			themes: ['github-light', 'github-dark'],
			langs: ['svelte', 'typescript', 'javascript', 'html', 'css', 'bash', 'json']
		})
	));
}

export async function highlight(code: string, lang: BundledLanguage | string = 'typescript') {
	const highlighter = await get_highlighter();
	return highlighter.codeToHtml(code.replace(/^\n/, '').replace(/\n$/, ''), {
		lang,
		themes: {
			light: 'github-light',
			dark: 'github-dark'
		},
		// Follows `color-scheme` from app.css (system light/dark) — no extra CSS vars.
		defaultColor: 'light-dark()'
	});
}
