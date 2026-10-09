/**
 * QUERIES OVER THE STACK INDEX (analyze.ts `StackIndex`): the samples of one render with their
 * stacks, asked "what ran in this range" and "what was the stack at this instant". Pure and
 * cheap — a range query walks the samples once and each sample's stack once — so the report's
 * scrubber can answer while the mouse moves. No regex: the labels are compared as they are.
 */
import type { StackIndex, FrameCategory } from './analyze.js';

export interface RangeRow {
	/** the frame's name */
	name: string;
	file?: string;
	category: FrameCategory;
	/** ms the frame was the leaf (running itself) inside the range */
	self_ms: number;
	/** ms the frame was anywhere on the stack inside the range */
	total_ms: number;
}

export interface RangeSummary {
	t0: number;
	t1: number;
	/** CPU inside the range (idle samples excluded) */
	cpu_ms: number;
	idle_ms: number;
	/** by self time, desc */
	self: RangeRow[];
	/** by inclusive time, desc — the owners of the range */
	total: RangeRow[];
	/** the components on the stacks in the range, by inclusive time */
	components: RangeRow[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** the first sample index whose end reaches `t` (binary search on the sorted starts) */
function first_at(index: StackIndex, t: number): number {
	let lo = 0;
	let hi = index.t.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (index.t[mid] + index.d[mid] < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** What ran between `t0` and `t1` (ms from the window's start): self and inclusive time per
 *  frame, the components among them. A sample that straddles an edge counts by its overlap. */
export function range_hot(index: StackIndex, t0: number, t1: number, limit = 30): RangeSummary {
	const self = new Map<number, number>();
	const total = new Map<number, number>();
	let cpu = 0;
	let idle = 0;
	const seen: number[] = [];
	for (let i = first_at(index, t0); i < index.t.length; i++) {
		const s = index.t[i];
		if (s > t1) break;
		const e = s + index.d[i];
		const ms = Math.min(e, t1) - Math.max(s, t0);
		if (ms <= 0) continue;
		const leaf = index.leaf[i];
		if (leaf < 0) {
			idle += ms;
			continue;
		}
		cpu += ms;
		self.set(leaf, (self.get(leaf) ?? 0) + ms);
		// each frame on the stack once (a recursive frame appears once per depth; count it once)
		seen.length = 0;
		for (let f = leaf; f >= 0; f = index.frames[f].p) {
			if (seen.includes(f)) continue;
			seen.push(f);
			total.set(f, (total.get(f) ?? 0) + ms);
		}
	}
	const row = (f: number): RangeRow => {
		const fr = index.frames[f];
		return { name: fr.n, ...(fr.f ? { file: fr.f } : {}), category: fr.c, self_ms: round2(self.get(f) ?? 0), total_ms: round2(total.get(f) ?? 0) };
	};
	const by_self = [...self.keys()].sort((a, b) => self.get(b)! - self.get(a)!).slice(0, limit).map(row);
	const by_total = [...total.keys()].sort((a, b) => total.get(b)! - total.get(a)!);
	const components = by_total.filter((f) => index.frames[f].c === 'component').slice(0, limit).map(row);
	return { t0: round2(t0), t1: round2(t1), cpu_ms: round2(cpu), idle_ms: round2(idle), self: by_self, total: by_total.slice(0, limit).map(row), components };
}

export interface StackAt {
	t: number;
	/** the sample's length */
	ms: number;
	/** the stack, outermost first; empty when idle */
	frames: { name: string; file?: string; category: FrameCategory }[];
}

/** The stack at instant `t` (ms from the window's start). */
export function stack_at(index: StackIndex, t: number): StackAt | null {
	const i = first_at(index, t);
	if (i >= index.t.length || index.t[i] > t) return null;
	const frames: StackAt['frames'] = [];
	for (let f = index.leaf[i]; f >= 0; f = index.frames[f].p) {
		const fr = index.frames[f];
		frames.push({ name: fr.n, ...(fr.f ? { file: fr.f } : {}), category: fr.c });
	}
	frames.reverse();
	return { t: round2(index.t[i]), ms: round2(index.d[i]), frames };
}

/** The CPU of the window as `bins` equal slices: ms of CPU per slice, for a density strip.
 *  `by`: 'all' for any frame; a category to count only samples whose leaf is that category. */
export function density(index: StackIndex, bins = 200, by: 'all' | FrameCategory = 'all'): number[] {
	const out = new Array<number>(bins).fill(0);
	const w = index.window_ms || 1;
	for (let i = 0; i < index.t.length; i++) {
		const leaf = index.leaf[i];
		if (leaf < 0) continue;
		if (by !== 'all' && index.frames[leaf].c !== by) continue;
		const s = index.t[i];
		const e = s + index.d[i];
		let b0 = Math.floor((s / w) * bins);
		const b1 = Math.min(bins - 1, Math.floor((e / w) * bins));
		if (b0 < 0) b0 = 0;
		for (let b = b0; b <= b1; b++) {
			const bs = (b / bins) * w;
			const be = ((b + 1) / bins) * w;
			out[b] += Math.max(0, Math.min(e, be) - Math.max(s, bs));
		}
	}
	return out.map(round2);
}
