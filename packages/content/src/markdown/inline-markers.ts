/**
 * `+++added+++` / `---removed---` INLINE diff markers — svelte.dev's fence dialect for marking a
 * changed SPAN inside a line (the line-level cousin is {@link ./diff.js diff_markers}). Ported to
 * COMPOSE WITH twoslash: a decoration-based version breaks the moment twoslash rewrites the code
 * (the `---cut---` banner shifts every offset), so this works in two offset-free passes:
 *
 *  - `preprocess` replaces each marker DELIMITER with a unique-length run of spaces (whitespace that
 *    twoslash type-checks happily and never reports on), leaving the marked content in place. Removed
 *    (`---`) content is additionally redacted to form-feeds so intentionally-broken "before" code
 *    can't make twoslash error; the originals are stashed on the per-call `this.meta`.
 *  - `postprocess` finds those space runs in the RENDERED HTML and wraps the content between them in
 *    `<span class="…">` — pure string surgery, independent of twoslash's token/offset bookkeeping
 *    and of the JS↔TS variant split.
 *
 * Rules kept from the real svelte.dev corpus: a `---` ALONE on a line is never a marker (frontmatter
 * shown in a fence / an `<hr>`); markers pair with the next same-type marker; an unpaired marker is
 * left as-is.
 */
import type { ShikiTransformer } from 'shiki';

// ── regexes
const LF_G = /\n/g;

type Marker = '+++' | '---';
// Distinct, improbable-in-real-code lengths so the postprocess pattern can't false-match. The
// delimiter becomes this many spaces; the content keeps its own length.
const SUB: Record<Marker, string> = { '+++': ' '.repeat(41), '---': ' '.repeat(43) };

// Markdown-family fences are where the AUTHORING SYNTAX itself is shown (a docs page teaching the
// dialect) — a marker there must render literally. Same rule as diff_markers; `diff` because its
// `---` lines are real syntax.
const SKIP_LANGS = new Set(['diff', 'markdown', 'md', 'mdx', 'svx']);

type Redaction = { placeholder: string; content: string };
type MarkerMeta = { redactions: Redaction[] };

export type InlineMarkerOptions = {
	/** Class(es) for the wrapping `<span>`s. Defaults style via `theme.css` (`og-mark-*`); pass your
	 *  own to match an existing skin (svelte.dev uses `highlight add` / `highlight remove`). */
	classes?: { add?: string; remove?: string };
};

/** True when the marker at `i` sits alone on its line (only whitespace around it). */
function alone_on_line(src: string, i: number, len: number): boolean {
	const bol = src.lastIndexOf('\n', i - 1) + 1;
	let eol = src.indexOf('\n', i + len);
	if (eol === -1) eol = src.length;
	return src.slice(bol, i).trim() === '' && src.slice(i + len, eol).trim() === '';
}

/** Wrap every `SUB…content…SUB` region of `html` in `<span class="classname">`, splitting cleanly
 *  around Shiki's own token `<span>`s and re-opening per line. */
function highlight_all_spans(html: string, sub: string, classname: string): string {
	const open = `<span class="${classname}">`;
	const pattern = new RegExp(`${sub}([^ ]|[^ ][^]+?[^ ])${sub}`, 'g');
	return html.replace(pattern, (_m, content: string, index: number) => {
		const a = content.indexOf('<span');
		const b = content.indexOf('</span');
		const c = content.lastIndexOf('<span');
		const d = content.lastIndexOf('</span');
		let adjusted = content;
		if (b !== -1 && (a === -1 || b < a)) {
			// content starts INSIDE a token span — close it, open ours, re-open the token
			const tag_start = html.lastIndexOf('<span', index);
			const tag = html.slice(tag_start, html.indexOf('>', tag_start) + 1);
			adjusted = `</span>${open}${tag}${adjusted}`;
		} else {
			adjusted = `${open}${adjusted}`;
		}
		if (c !== -1 && (d === -1 || c > d)) {
			// content ends INSIDE a token span — close ours + the token, re-open the token
			const tag = content.slice(c, content.indexOf('>', c) + 1);
			adjusted = `${adjusted}</span></span>${tag}`;
		} else {
			adjusted = `${adjusted}</span>`;
		}
		// a multi-line highlight must close/re-open at every newline (spans can't cross lines)
		return adjusted.replace(LF_G, `</span>\n${open}`);
	});
}

export function inline_markers(options: InlineMarkerOptions = {}): ShikiTransformer {
	const CLASS: Record<Marker, string> = {
		'+++': options.classes?.add ?? 'og-mark og-mark-add',
		'---': options.classes?.remove ?? 'og-mark og-mark-remove'
	};
	return {
		name: 'ogygia:inline-markers',
		preprocess(code) {
			if (SKIP_LANGS.has(String(this.options.lang ?? '').toLowerCase())) return undefined;
			// Find paired markers in one scan; rebuild the source with delimiters → space runs and
			// removed content → form-feeds (stashed for restore).
			const found: Array<{ at: number; m: Marker }> = [];
			for (let i = 0; i < code.length - 2; i++) {
				const m = code.slice(i, i + 3) as Marker;
				if (m !== '+++' && m !== '---') continue;
				if (m === '---' && alone_on_line(code, i, 3)) continue;
				found.push({ at: i, m });
				i += 2;
			}
			if (!found.length) return undefined;

			const meta = ((this.meta as Record<string, unknown>).__og_inline_markers ??= {
				redactions: []
			}) as MarkerMeta;
			let out = '';
			let last = 0;
			for (let i = 0; i < found.length - 1; i++) {
				const open = found[i]!;
				const close = found[i + 1]!;
				if (close.m !== open.m) continue; // mismatched neighbors — leave for a later pair
				out += code.slice(last, open.at);
				const content = code.slice(open.at + 3, close.at);
				if (open.m === '---') {
					// redact removed content so twoslash can't error on it; restore in postprocess
					const placeholder = '\f'.repeat(content.length);
					meta.redactions.push({ placeholder, content });
					out += SUB['---'] + placeholder + SUB['---'];
				} else {
					out += SUB['+++'] + content + SUB['+++'];
				}
				last = close.at + 3;
				i++; // consume the pair
			}
			out += code.slice(last);
			return out;
		},
		postprocess(html) {
			const meta = (this.meta as Record<string, unknown>).__og_inline_markers as
				| MarkerMeta
				| undefined;
			let out = html;
			// Restore redacted removed-content (still fenced by its `---` space runs) before matching.
			if (meta) {
				for (const { placeholder, content } of meta.redactions)
					out = out.replace(placeholder, content);
			}
			out = highlight_all_spans(out, SUB['---'], CLASS['---']);
			out = highlight_all_spans(out, SUB['+++'], CLASS['+++']);
			return out;
		}
	};
}
