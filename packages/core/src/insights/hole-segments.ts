/**
 * A HOLE'S ANSWER, CUT INTO ITS PARTS — the one cut the devtools Page tab's waterfall and the
 * profiler report's One clock both draw. Where the browser (Resource Timing) and the server
 * (Server-Timing `og-queue`, `og-render`) timed it: before its request left (a busy page, the
 * runtime's queue), the server's wait for a render slot, the server render (or, untimed, the wait
 * for the first byte), then the rest (network, the body, the swap). Page times, ms.
 */

export interface HoleTimes {
	/** when its fallback began to count (the first paint, or the hole's own start) */
	shown_at?: number;
	/** how long its fallback stood: from `shown_at` to the swap */
	wait_ms: number;
	left_at?: number;
	first_at?: number;
	server_queue_ms?: number;
	server_ms?: number;
}

export type HoleSegKind = 'wait' | 'before' | 'slot' | 'render' | 'server' | 'rest';

export const HOLE_SEG_LABEL: Record<HoleSegKind, string> = {
	wait: 'waiting for its answer',
	before: 'before its request left',
	slot: 'waiting for a render slot on the server',
	render: 'the server render',
	server: 'waiting on the server',
	rest: 'network, the body and the swap'
};

/** The segments, in order. Without a timing, one: the wait. A request the document preloaded
 *  starts before the fallback counts: its segments start where it left. */
export function hole_segments(h: HoleTimes): { k: HoleSegKind; a: number; b: number }[] {
	const shown = h.shown_at ?? 0;
	const at = shown + h.wait_ms;
	if (h.left_at === undefined) return [{ k: 'wait', a: shown, b: at }];
	const out: { k: HoleSegKind; a: number; b: number }[] = [];
	const left = h.left_at;
	if (left > shown) out.push({ k: 'before', a: shown, b: left });
	let t = left;
	if (h.server_queue_ms) out.push({ k: 'slot', a: t, b: (t += h.server_queue_ms) });
	if (h.server_ms !== undefined) out.push({ k: 'render', a: t, b: (t += h.server_ms) });
	else if (h.first_at !== undefined) out.push({ k: 'server', a: t, b: (t = h.first_at) });
	if (at > t) out.push({ k: 'rest', a: t, b: at });
	return out;
}
