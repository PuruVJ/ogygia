/**
 * THE INSTANCE WAS NOT ALONE — the other requests the server answered while the profiled
 * render ran. One Node process has one event loop: every other request's CPU is a turn the
 * render waited for, and that wait sits inside the render's wall time with no frame of its own.
 * This names them, with how long each overlapped the render, so the report can say how much of
 * the wall was the instance being busy with something else. Pure over the request ring.
 *
 * A request's `cpu_ms` is a process-wide delta over its lifetime: when two overlap, each carries
 * some of the other's CPU. The per-request estimate is therefore an UPPER BOUND, capped at the
 * overlap itself, and labelled so.
 */
import type { RequestEntry } from './report.js';

export interface ContendingRequest {
	method: string;
	path: string;
	route: string | null;
	status: number;
	ms: number;
	/** ms of its lifetime inside the profiled window(s) */
	overlap_ms: number;
	/** at most this much of the window's CPU was its (upper bound) */
	cpu_max_ms: number;
	/** `self`: a call the profiled render made to its own server (the same event loop answered
	 *  both sides); `hole`: one of the page's own deferred holes (the page's work, answered while
	 *  it rendered); `other`: a request from somewhere else */
	kind: 'self' | 'hole' | 'other';
}

export interface Contention {
	requests: ContendingRequest[];
	/** the sum of the overlaps (a wall-time measure: two requests over one ms count twice) */
	overlap_ms: number;
	/** the upper bound on CPU the window lost to them, summed */
	cpu_max_ms: number;
	/** how many were in flight when the profiled render(s) started, from the render's own entry */
	inflight_at_start: number[];
	/** per profiled window: how many others overlapped it and for how long */
	per_window: { n: number; overlap_ms: number; cpu_max_ms: number }[];
	/** the share of the windows' total length that had another request in flight */
	busy_share: number;
}

export interface ContentionInput {
	/** the ring, any order */
	requests: readonly RequestEntry[];
	/** the profiled window(s) on performance.now()'s clock */
	windows: readonly { start: number; end: number }[];
	/** the profiled renders' own ring entries (internal), to read `inflight` off */
	own?: readonly RequestEntry[];
	/** the paths the profiled render called on its own server (its outbound calls' pathnames):
	 *  a ring entry on one of them is the render waiting on itself, not a stranger */
	self_paths?: ReadonlySet<string>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const HOLE_PREFIX = '/__ogygia__';

export function contention(input: ContentionInput): Contention | undefined {
	const windows = input.windows;
	if (!windows.length) return undefined;
	const per_window = windows.map(() => ({ n: 0, overlap_ms: 0, cpu_max_ms: 0 }));
	const rows: ContendingRequest[] = [];
	let overlap_total = 0;
	let cpu_total = 0;
	// the union of "another request was in flight" over the windows, for the share
	const busy: [number, number][] = [];
	for (const e of input.requests) {
		if (e.internal || e.pt === undefined) continue;
		const s = e.pt;
		const t = e.pt + e.ms;
		let overlap = 0;
		for (let i = 0; i < windows.length; i++) {
			const w = windows[i];
			const ov = Math.min(t, w.end) - Math.max(s, w.start);
			if (ov <= 0) continue;
			overlap += ov;
			per_window[i].n++;
			per_window[i].overlap_ms += ov;
			busy.push([Math.max(s, w.start), Math.min(t, w.end)]);
		}
		if (overlap <= 0) continue;
		// its CPU across the overlap, capped by the overlap: an upper bound either way
		const cpu_max = Math.min(overlap, e.ms > 0 ? e.cpu_ms * (overlap / e.ms) : 0);
		for (let i = 0; i < windows.length; i++) {
			const w = windows[i];
			const ov = Math.min(t, w.end) - Math.max(s, w.start);
			if (ov > 0) per_window[i].cpu_max_ms += cpu_max * (ov / overlap);
		}
		overlap_total += overlap;
		cpu_total += cpu_max;
		rows.push({
			method: e.method,
			path: e.path,
			route: e.route,
			status: e.status,
			ms: round2(e.ms),
			overlap_ms: round2(overlap),
			cpu_max_ms: round2(cpu_max),
			kind: e.hole || e.path.startsWith(HOLE_PREFIX) ? 'hole' : input.self_paths?.has(e.path) ? 'self' : 'other'
		});
	}
	const inflight = (input.own ?? []).filter((e) => e.internal && typeof e.inflight === 'number').map((e) => e.inflight);
	// union length of the busy intervals over the windows' total length
	busy.sort((a, b) => a[0] - b[0]);
	let union = 0;
	let cur: [number, number] | null = null;
	for (const iv of busy) {
		if (cur && iv[0] <= cur[1]) cur[1] = Math.max(cur[1], iv[1]);
		else {
			if (cur) union += cur[1] - cur[0];
			cur = iv;
		}
	}
	if (cur) union += cur[1] - cur[0];
	const total_len = windows.reduce((a, w) => a + Math.max(0, w.end - w.start), 0) || 1;
	if (!rows.length && !inflight.some((n) => n > 0)) return undefined;
	rows.sort((a, b) => b.overlap_ms - a.overlap_ms);
	return {
		requests: rows.slice(0, 40),
		overlap_ms: round2(overlap_total),
		cpu_max_ms: round2(cpu_total),
		inflight_at_start: inflight,
		per_window: per_window.map((p) => ({ n: p.n, overlap_ms: round2(p.overlap_ms), cpu_max_ms: round2(p.cpu_max_ms) })),
		busy_share: round2(Math.min(1, union / total_len))
	};
}
