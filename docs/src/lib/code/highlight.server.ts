/**
 * Shiki highlighter — server-only (`.server.ts`). Never import from client islands.
 * On csr=false pages, CodeBlock SSRs to HTML; as a server island (`defer`) it renders
 * in the region endpoint. Either way the browser only receives highlighted markup.
 */
import { createHighlighter, type BundledLanguage } from 'shiki';

const highlighter = await createHighlighter({
	themes: ['github-light', 'github-dark'],
	langs: ['svelte', 'typescript', 'javascript', 'html', 'css', 'bash', 'json']
});

export async function highlight(code: string, lang: BundledLanguage | string = 'typescript') {
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
