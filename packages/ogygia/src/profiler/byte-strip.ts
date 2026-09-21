/**
 * THE DOCUMENT AS A BYTE STRIP — what each byte of the HTML the server sent IS: head markup,
 * inline styles, stylesheet links, the runtime bootstrap, other scripts, the page seed, the remote
 * seed, the island props tail, the holes record, each island's markup (named by its fingerprint,
 * the report joins it to the island's row), lakes and holes, declarative shadow DOM a design
 * system rendered, and plain markup. Pure: a string in, ordered segments out. The report draws
 * the strip with the time each byte left the server and the time the browser had it.
 */
import { scanRegions } from '../server/split-regions.js';

export type StripKind =
	| 'head'
	| 'style'
	| 'css-link'
	| 'runtime'
	| 'script'
	| 'seed'
	| 'remote-seed'
	| 'props'
	| 'holes'
	| 'island'
	| 'lake'
	| 'hole'
	| 'shadow'
	| 'markup';

export interface StripSegment {
	kind: StripKind;
	start: number;
	end: number;
	/** an island's fingerprint / a script's type — what the report names the segment by */
	label?: string;
}

export interface ByteStrip {
	total: number;
	segments: StripSegment[];
	/** bytes per kind over the whole document (shadow DOM counted wherever it sits, islands included) */
	by_kind: Partial<Record<StripKind, number>>;
	/** declarative shadow roots anywhere in the document, bytes — a design system's server render */
	shadow_bytes: number;
	shadow_count: number;
	/** when each chunk of the document LEFT the server (end offset, ms after the render began) —
	 *  present when the page streamed in more than one chunk */
	chunks?: { end: number; t: number }[];
}

/** When a byte left the server, from the chunk stamps: the chunk that carried it. */
export function left_at(offset: number, chunks: { end: number; t: number }[]): number | undefined {
	for (const c of chunks) if (offset < c.end) return c.t;
	return chunks.length ? chunks[chunks.length - 1].t : undefined;
}

const SCRIPT_RE = /<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi;
const STYLE_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const LINK_RE = /<link\b[^>]*>/gi;
const TEMPLATE_RE = /<template\b[^>]*\bshadowrootmode\b[^>]*>[\s\S]*?<\/template\s*>/gi;
const HEAD_END_RE = /<\/head\s*>/i;
const REL_STYLESHEET_RE = /\brel\s*=\s*["']?(?:[^"'>\s]*\s)?stylesheet\b/i;
const FP_ATTR = 'data-og-fp';

function script_kind(attrs: string): { kind: StripKind; label?: string } {
	if (/data-ogygia-runtime/.test(attrs)) return { kind: 'runtime' };
	if (/data-ogygia-props/.test(attrs)) return { kind: 'props' };
	if (/data-ogygia-holes/.test(attrs)) return { kind: 'holes' };
	if (/application\/ogygia-page/.test(attrs)) return { kind: 'seed' };
	if (/application\/ogygia-remote/.test(attrs)) return { kind: 'remote-seed' };
	const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
	const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
	return { kind: 'script', label: src ? `src ${src.split('/').pop()}` : type ? `type ${type}` : 'inline' };
}

export function byte_strip(html: string): ByteStrip {
	const spans: StripSegment[] = [];
	let m: RegExpExecArray | null;
	SCRIPT_RE.lastIndex = 0;
	while ((m = SCRIPT_RE.exec(html))) spans.push({ ...script_kind(m[1]), start: m.index, end: m.index + m[0].length });
	STYLE_RE.lastIndex = 0;
	while ((m = STYLE_RE.exec(html))) spans.push({ kind: 'style', start: m.index, end: m.index + m[0].length });
	LINK_RE.lastIndex = 0;
	while ((m = LINK_RE.exec(html))) if (REL_STYLESHEET_RE.test(m[0])) spans.push({ kind: 'css-link', start: m.index, end: m.index + m[0].length, label: /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(m[0])?.[1]?.split('/').pop() });
	let shadow_bytes = 0;
	let shadow_count = 0;
	TEMPLATE_RE.lastIndex = 0;
	while ((m = TEMPLATE_RE.exec(html))) {
		shadow_bytes += m[0].length;
		shadow_count++;
		spans.push({ kind: 'shadow', start: m.index, end: m.index + m[0].length });
	}
	// regions: every top-level one is a segment (an island's bytes are one block, whatever is inside)
	try {
		for (const r of scanRegions(html)) {
			if (r.depth !== 0) continue;
			const kind: StripKind = r.kind === 'island' ? 'island' : r.kind === 'lake' ? 'lake' : r.kind === 'hole' ? 'hole' : 'markup';
			spans.push({ kind, start: r.start, end: r.end, label: r.attrs[FP_ATTR] ?? r.attrs.entry ?? r.attrs.name });
		}
	} catch {
		/* a scanner that throws on a broken document leaves the strip to the regexes */
	}
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	// drop spans inside an earlier one (a script inside an island is the island's bytes), fill gaps
	const head_end = HEAD_END_RE.exec(html);
	const head_at = head_end ? head_end.index + head_end[0].length : 0;
	const out: StripSegment[] = [];
	let pos = 0;
	const fill = (to: number) => {
		if (to <= pos) return;
		if (pos < head_at && to > head_at) {
			out.push({ kind: 'head', start: pos, end: head_at });
			out.push({ kind: 'markup', start: head_at, end: to });
		} else out.push({ kind: to <= head_at ? 'head' : 'markup', start: pos, end: to });
		pos = to;
	};
	for (const s of spans) {
		if (s.start < pos) continue; // nested (or overlapping) — already inside a segment
		fill(s.start);
		out.push(s);
		pos = s.end;
	}
	fill(html.length);
	const by_kind: Partial<Record<StripKind, number>> = {};
	for (const s of out) by_kind[s.kind] = (by_kind[s.kind] ?? 0) + (s.end - s.start);
	if (shadow_bytes) by_kind.shadow = shadow_bytes;
	return { total: html.length, segments: out, by_kind, shadow_bytes, shadow_count };
}

/** A segment's arrival at the browser, given the document's download span from navigation timing:
 *  bytes are assumed to arrive at a steady rate between the first byte and the last. */
export function arrival_ms(s: { start: number; end: number }, total: number, res_start: number, res_end: number): { first: number; last: number } {
	if (total <= 0 || res_end <= res_start) return { first: res_start, last: res_start };
	const per = (res_end - res_start) / total;
	return { first: res_start + s.start * per, last: res_start + s.end * per };
}
