/**
 * svelte.dev's `+++added+++` / `---removed---` inline diff markers, as a Shiki transformer — ported
 * to COMPOSE WITH twoslash (site-kit's technique). A previous decoration-based version broke twoslash:
 * decorations carry source offsets, and twoslash rewrites the code (the `---cut---` banner), so the
 * offsets landed in the wrong place. Instead:
 *
 *  - `preprocess` replaces each marker DELIMITER with a unique-length run of spaces (whitespace that
 *    twoslash type-checks happily and never reports on), leaving the marked content in place. Removed
 *    (`---`) content is additionally redacted to form-feeds so intentionally-broken "before" code
 *    can't make twoslash error; the originals are stashed on the per-call `this.meta`.
 *  - `postprocess` finds those space runs in the RENDERED HTML and wraps the content between them in
 *    `<span class="highlight add|remove">` — pure string surgery, so it's independent of twoslash's
 *    token/offset bookkeeping and of the JS↔TS variant split.
 *
 * Rules kept from the real corpus: a `---` ALONE on a line is never a marker (frontmatter shown in a
 * fence / an `<hr>`); markers pair with the next same-type marker; an unpaired marker is left as-is.
 */
import type { ShikiTransformer } from 'shiki';

type Marker = '+++' | '---';
const CLASS: Record<Marker, string> = { '+++': 'highlight add', '---': 'highlight remove' };
// Distinct, improbable-in-real-code lengths so the postprocess pattern can't false-match. The
// delimiter becomes this many spaces; the content keeps its own length.
const SUB: Record<Marker, string> = { '+++': ' '.repeat(41), '---': ' '.repeat(43) };

type Redaction = { placeholder: string; content: string };
type MarkerMeta = { redactions: Redaction[] };

/** True when the marker at `i` sits alone on its line (only whitespace around it). */
function alone_on_line(src: string, i: number, len: number): boolean {
	const bol = src.lastIndexOf('\n', i - 1) + 1;
	let eol = src.indexOf('\n', i + len);
	if (eol === -1) eol = src.length;
	return src.slice(bol, i).trim() === '' && src.slice(i + len, eol).trim() === '';
}

/** Wrap every `SUB…content…SUB` region of `html` in `<span class="classname">`, splitting cleanly
 *  around Shiki's own token `<span>`s and re-opening per line. (site-kit `highlight_all_spans`.) */
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
		return adjusted.replace(/\n/g, `</span>\n${open}`);
	});
}

export function inline_markers(): ShikiTransformer {
	return {
		name: 'svelte-dev:inline-markers@2',
		preprocess(code) {
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

			const meta = ((this.meta as Record<string, unknown>).__markers ??= { redactions: [] }) as MarkerMeta;
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
			const meta = (this.meta as Record<string, unknown>).__markers as MarkerMeta | undefined;
			let out = html;
			// Restore redacted removed-content (still fenced by its `---` space runs) before matching.
			if (meta) {
				for (const { placeholder, content } of meta.redactions) out = out.replace(placeholder, content);
			}
			out = highlight_all_spans(out, SUB['---'], CLASS['---']);
			out = highlight_all_spans(out, SUB['+++'], CLASS['+++']);
			return out;
		}
	};
}
