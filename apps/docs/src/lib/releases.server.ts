/**
 * The Releases page, sourced from the ONE changelog — `CHANGELOG.md` at the repo root (identical to
 * the package's, the file that ships to npm). Imported raw so the page is always in lockstep with what
 * we cut: edit the changelog, the page updates. No copy, no second source of truth.
 *
 * The changelog is a real release artifact — plain Keep-a-Changelog markdown with bare `<Region>` /
 * `{expr}` in its prose. That is NOT mdsvex-safe, so we do NOT run it through the site's `.svx`
 * pipeline (it would try to compile those as components and throw). Instead we render with
 * `markdown-it` in `html: false` mode — bare angle brackets and braces render as literal, escaped
 * text — and highlight fenced code with the site's own Shiki (`highlight.server.ts`), so code blocks
 * match every other snippet on the site. Server-only: Shiki never reaches the client.
 */
import MarkdownIt from 'markdown-it';
import changelog from '../../../../CHANGELOG.md?raw';
import { highlight } from './code/highlight.server.js';

/** One cut release: the parsed heading plus its notes rendered to static HTML. */
export type Release = {
	/** Semver, e.g. `0.5.0`. */
	version: string;
	/** ISO date from the heading, e.g. `2026-08-12` (empty if the heading omits one). */
	date: string;
	/** The release notes, rendered to HTML (prose escaped, fences highlighted). */
	html: string;
};

// Shiki is loaded with a fixed language set (see highlight.server.ts). Map the changelog's fence
// infostrings onto those; anything unknown falls back to plaintext so one exotic fence never throws.
const LANGS = new Set(['svelte', 'typescript', 'javascript', 'html', 'css', 'bash', 'json']);
const ALIAS: Record<string, string> = {
	ts: 'typescript',
	js: 'javascript',
	jsonc: 'json',
	sh: 'bash',
	shell: 'bash',
	zsh: 'bash'
};
function resolve_lang(info: string): string {
	const raw = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	const lang = ALIAS[raw] ?? raw;
	return LANGS.has(lang) ? lang : 'text';
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

/** Render one release body: highlight every fence up front (Shiki is async), then render the token
 *  stream with a fence rule that reads the pre-highlighted HTML back by content. */
async function render_notes(src: string): Promise<string> {
	const tokens = md.parse(src, {});
	const highlighted = new Map<string, string>();
	for (const t of tokens) {
		if (t.type !== 'fence' || highlighted.has(t.content)) continue;
		const lang = resolve_lang(t.info);
		highlighted.set(t.content, lang === 'text' ? '' : await highlight(t.content, lang));
	}
	md.renderer.rules.fence = (toks, idx) => {
		const t = toks[idx];
		return (
			highlighted.get(t.content) ||
			`<pre class="rel-code"><code>${md.utils.escapeHtml(t.content)}</code></pre>`
		);
	};
	return md.renderer.render(tokens, md.options, {});
}

// `## [0.5.0] — 2026-08-12` (em dash or hyphen, date optional). Splits the file into releases; the
// preamble before the first heading is dropped.
const HEADING = /^##\s+\[([^\]]+)\][^\n]*?(\d{4}-\d{2}-\d{2})?\s*$/gm;

let cache: Promise<Release[]> | null = null;

/** Parse + render every release, newest first (the changelog is already authored newest-first). Memoized
 *  — the changelog is a build constant, so the whole thing renders once per server process. */
export function get_releases(): Promise<Release[]> {
	return (cache ??= (async () => {
		const marks: { version: string; date: string; start: number; bodyStart: number }[] = [];
		for (let m = HEADING.exec(changelog); m; m = HEADING.exec(changelog)) {
			marks.push({
				version: m[1].trim(),
				date: m[2] ?? '',
				start: m.index,
				bodyStart: m.index + m[0].length
			});
		}
		return Promise.all(
			marks.map(async (mark, i) => {
				const end = i + 1 < marks.length ? marks[i + 1].start : changelog.length;
				const body = changelog.slice(mark.bodyStart, end).trim();
				return { version: mark.version, date: mark.date, html: await render_notes(body) };
			})
		);
	})());
}
