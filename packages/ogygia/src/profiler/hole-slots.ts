/**
 * HOLE RENDER SLOTS, across the server. A server process renders a few holes at a time
 * (`REGION_RENDER_CONCURRENCY`), and a render holds its slot through its awaits: a hole waiting
 * on slow data keeps the next hole — any visitor's — queued. The endpoint records each hole
 * request's wait for a slot (`HoleRequestStats.queue_ms`); this reads the request log for which
 * holes waited, and which held the slots while they did.
 *
 * On a host that runs one request per instance (AWS Lambda) nothing ever queues: the table still
 * shows each hole's render and cache, and the summary stays silent.
 */
import { REGION_RENDER_CONCURRENCY } from '../runtime/concurrency.js';
import type { RequestEntry } from './report.js';

export interface HoleSlotRow {
	id: string;
	/** the component and a props preview, from a page that minted it (else the id) */
	name: string;
	requests: number;
	/** served from the render cache (no render, no slot) */
	hits: number;
	/** answered 500 (the render threw or timed out): no render time */
	failed: number;
	/** mean render per rendered request (its time in the slot), ms */
	render_ms: number;
	/** mean and worst wait for a slot per rendered request, ms */
	queue_ms: number;
	queue_max_ms: number;
	/** its part of all the slot time spent (0–1): who held the slots */
	slot_share: number;
}

export interface HoleSlots {
	rows: HoleSlotRow[];
	/** the slots per process */
	slots: number;
	/** rendered hole requests, and how many waited 50 ms or more for a slot */
	rendered: number;
	queued: number;
	/** the mean wait of those that waited, ms */
	queued_mean_ms: number;
	/** one line for the dashboard, when holes waited; null when none did */
	summary: string | null;
}

const QUEUED_MS = 50;

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export function hole_slots(ring: readonly RequestEntry[]): HoleSlots | null {
	// names: the component the endpoint recorded (the server manifest's), else a page's row (while
	// recording). One id is one component; its props differ per copy, so a row names the props
	// only when the page held the one copy
	const names = new Map<string, string>();
	const props = new Map<string, Set<string>>();
	for (const e of ring)
		for (const h of e.og?.hole_rows ?? []) {
			if (h.name && !names.has(h.id)) names.set(h.id, h.name);
			const set = props.get(h.id) ?? props.set(h.id, new Set()).get(h.id)!;
			// (a row folds its copies: several copies are several props)
			if (h.props) set.add(h.count > 1 ? `${h.props}×${h.count}` : h.props);
		}
	const by = new Map<string, { requests: number; hits: number; failed: number; rendered: number; render: number; queue: number; queue_max: number; name?: string }>();
	let queued = 0;
	let queued_sum = 0;
	for (const e of ring) {
		const h = e.hole;
		if (!h) continue;
		const s = by.get(h.id) ?? { requests: 0, hits: 0, failed: 0, rendered: 0, render: 0, queue: 0, queue_max: 0 };
		s.requests++;
		s.name ??= h.name;
		// a failed render (it threw, it timed out) is not a render time
		if (e.status >= 500) s.failed++;
		else if (h.cache === 'hit') s.hits++;
		else {
			const q = h.queue_ms ?? 0;
			s.rendered++;
			s.queue += q;
			s.queue_max = Math.max(s.queue_max, q);
			s.render += Math.max(0, e.ms - q);
			if (q >= QUEUED_MS) {
				queued++;
				queued_sum += q;
			}
		}
		by.set(h.id, s);
	}
	if (!by.size) return null;
	const slot_total = [...by.values()].reduce((a, s) => a + s.render, 0) || 1;
	const rows: HoleSlotRow[] = [...by.entries()]
		.map(([id, s]) => {
			const name = s.name ?? names.get(id) ?? id;
			const copies = props.get(id);
			const one = copies?.size === 1 ? [...copies][0] : undefined;
			return {
			id,
			name: one && !one.includes('×') ? `${name} ${one}` : name,
			requests: s.requests,
			hits: s.hits,
			failed: s.failed,
			render_ms: s.rendered ? s.render / s.rendered : 0,
			queue_ms: s.rendered ? s.queue / s.rendered : 0,
			queue_max_ms: s.queue_max,
			slot_share: s.render / slot_total
			};
		})
		.sort((a, b) => b.slot_share - a.slot_share);
	const rendered = rows.reduce((a, r) => a + r.requests - r.hits - r.failed, 0);
	const queued_mean_ms = queued ? queued_sum / queued : 0;
	let summary: string | null = null;
	if (queued) {
		// who held the slots: the holes with the most slot time, down to three
		const holders = rows.filter((r) => r.slot_share >= 0.2).slice(0, 3);
		const held = holders.length
			? ` The slots were held mostly by ${holders.map((r) => `${r.name} (${Math.round(r.slot_share * 100)}% of slot time, ${fmt(r.render_ms)} a render)`).join(', ')}.`
			: '';
		summary =
			`${queued} of ${rendered} hole render${rendered === 1 ? '' : 's'} waited for a render slot, ${fmt(queued_mean_ms)} on average (the worst ${fmt(Math.max(...rows.map((r) => r.queue_max_ms)))}).` +
			held +
			` A server process renders ${REGION_RENDER_CONCURRENCY} holes at a time, and each holds its slot while it awaits its data: make the slow ones answer sooner (a maxAge, faster data).`;
	}
	return { rows, slots: REGION_RENDER_CONCURRENCY, rendered, queued, queued_mean_ms, summary };
}
