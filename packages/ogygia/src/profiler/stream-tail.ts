/**
 * WHAT HELD THE DOCUMENT OPEN — a streamed page ships its shell, then keeps the response open until
 * its last streamed promise settles (a `<script>__ogygia_page_resolve(id, …)</script>` per settle,
 * after `</html>`). The browser fires DOMContentLoaded only when the document ends, and islands wake
 * after it, so the slowest streamed promise holds every island on the page. Read off the profiled
 * render's body: the biggest pause between chunks splits the early part from the late tail, and each
 * resolve script in the tail is named by the `page.data` key its id stands for (page-insights
 * `defer_keys`, the Page tab's own reading). Pure; indexOf only.
 */
import { PAGE_DEFER_GLOBAL, PAGE_DEFER_KEY } from '../page-defer.js';
import { defer_keys } from '../devtools/page-insights.js';
import { left_at, type ByteStrip, type StripKind } from './byte-strip.js';

export interface StreamTail {
	/** the early part: its last byte left the server at `early_ms` (ms into the render) */
	early_ms: number;
	early_bytes: number;
	/** the tail: its last byte left at `late_ms` */
	late_ms: number;
	late_bytes: number;
	/** each streamed promise that settled in the tail, in the order it left: its `page.data` key
	 *  (a dotted path one level deep; null when the seed cannot say) and when */
	keys: { key: string | null; id: number; left_ms: number }[];
	/** the tail's other bytes by what they are (an island's markup: its fingerprint) */
	other: { kind: StripKind; label?: string; bytes: number }[];
}

/** a pause between chunks shorter than this is the server writing, not waiting */
const MIN_PAUSE_MS = 100;

export function stream_tail(html: string, strip: ByteStrip, chunks: { end: number; t: number }[]): StreamTail | null {
	if (chunks.length < 2) return null;
	let split = -1;
	let pause = 0;
	for (let i = 1; i < chunks.length; i++) {
		const d = chunks[i].t - chunks[i - 1].t;
		if (d > pause) {
			pause = d;
			split = i;
		}
	}
	if (split === -1 || pause < MIN_PAUSE_MS) return null;
	const early_end = chunks[split - 1].end;
	const last = chunks[chunks.length - 1];
	const names = defer_keys(html, PAGE_DEFER_KEY);
	const keys: StreamTail['keys'] = [];
	const call = `${PAGE_DEFER_GLOBAL}(`;
	const resolves: { start: number; end: number }[] = [];
	for (let at = html.indexOf(call, early_end); at !== -1; at = html.indexOf(call, at + call.length)) {
		let n = 0;
		let j = at + call.length;
		let digits = 0;
		for (; j < html.length && html.charCodeAt(j) >= 48 && html.charCodeAt(j) <= 57; j++, digits++) n = n * 10 + (html.charCodeAt(j) - 48);
		if (!digits) continue;
		keys.push({ key: names.get(n) ?? null, id: n, left_ms: left_at(at, chunks) ?? last.t });
		resolves.push({ start: at, end: html.indexOf('</script', at) });
	}
	// (a segment that is one of those resolve scripts is counted as its key, not again as a script)
	const in_resolve = (s: { start: number; end: number }) => resolves.some((r) => s.start <= r.start && r.end <= s.end);
	const other = new Map<string, { kind: StripKind; label?: string; bytes: number }>();
	for (const s of strip.segments) {
		const from = Math.max(s.start, early_end);
		if (s.end <= from || in_resolve(s)) continue;
		const k = `${s.kind}|${s.label ?? ''}`;
		const o = other.get(k) ?? { kind: s.kind, ...(s.label ? { label: s.label } : {}), bytes: 0 };
		o.bytes += s.end - from;
		other.set(k, o);
	}
	keys.sort((a, b) => a.left_ms - b.left_ms);
	return {
		early_ms: chunks[split - 1].t,
		early_bytes: early_end,
		late_ms: last.t,
		late_bytes: html.length - early_end,
		keys,
		other: [...other.values()].sort((a, b) => b.bytes - a.bytes)
	};
}
