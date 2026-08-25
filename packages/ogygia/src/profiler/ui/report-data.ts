/**
 * Pure data prep for the Report component — the aggregations report.ts used to bake straight into
 * HTML (treemap hierarchy, budget segments, waiting-by-function rows, host rollup, waterfall bars,
 * memory sparkline). Kept out of the .svelte file so it stays plain, testable logic; the component
 * just renders what these return. Findings/sequential/io-kind are reused from their existing homes.
 */
import type { Analysis, FrameCategory, GroupStat } from '../analyze.js';
import type { NetCall } from '../net.js';
import type { IoOp } from '../async-io.js';
import type { MemSample } from '../report.js';
import { io_kind } from '../async-io.js';
import { CATEGORY_LABEL, CATEGORY_COLOR } from './format.js';

/** The size to show for a call: the DECODED body when we measured it (robust — a cloned-stream count),
 *  else the wire size from content-length, else undefined. */
export function net_size(c: NetCall): number | undefined {
	return c.bytes ?? c.transfer_bytes;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface TreeNode {
	label: string;
	value: number;
	color: string;
	pct?: number;
	sub?: string;
	children?: TreeNode[];
}

/** Root → category → leaf hierarchy of self-time, capped per group (long tail → one "(N more)"). */
export function build_treemap(a: Analysis): TreeNode | null {
	interface Leaf {
		name: string;
		cat: FrameCategory;
		value: number;
		url: string;
	}
	const leaves: Leaf[] = a.functions
		.filter((f) => f.self_ms > 0)
		.map((f) => ({ name: f.name, cat: f.category, value: f.self_ms, url: f.url }));
	for (const b of a.buckets) {
		if (b.category === 'gc' && b.self_ms > 0)
			leaves.push({ name: 'garbage collection', cat: 'gc', value: b.self_ms, url: '' });
		if (b.category === 'v8' && b.self_ms > 0)
			leaves.push({ name: 'v8 internals', cat: 'v8', value: b.self_ms, url: '' });
	}
	if (!leaves.length) return null;

	const groups = new Map<FrameCategory, Leaf[]>();
	for (const l of leaves) {
		const g = groups.get(l.cat) ?? [];
		g.push(l);
		groups.set(l.cat, g);
	}
	const cat_cells: { cat: FrameCategory; value: number; leaves: Leaf[] }[] = [];
	for (const [cat, list] of groups) {
		list.sort((x, y) => y.value - x.value);
		const keep = list.slice(0, 16);
		const tail = list.slice(16);
		if (tail.length) {
			const sum = tail.reduce((s, i) => s + i.value, 0);
			keep.push({ name: `(${tail.length} more)`, cat, value: sum, url: '' });
		}
		cat_cells.push({ cat, value: list.reduce((s, i) => s + i.value, 0), leaves: keep });
	}
	cat_cells.sort((x, y) => y.value - x.value);

	const busy = a.busy_ms || 1;
	return {
		label: 'all',
		value: cat_cells.reduce((s, c) => s + c.value, 0),
		color: '#6b7280',
		children: cat_cells.map((c) => ({
			label: CATEGORY_LABEL[c.cat],
			value: round1(c.value),
			color: CATEGORY_COLOR[c.cat],
			pct: round1((c.value / busy) * 100),
			children: c.leaves.map((l) => ({
				label: l.name,
				sub: l.url,
				value: round1(l.value),
				color: CATEGORY_COLOR[c.cat],
				pct: round1((l.value / busy) * 100)
			}))
		}))
	};
}

/** Distinct categories present in the treemap, for the legend. */
export function treemap_legend(a: Analysis): FrameCategory[] {
	const cats = new Set<FrameCategory>();
	for (const f of a.functions) if (f.self_ms > 0) cats.add(f.category);
	for (const b of a.buckets)
		if ((b.category === 'gc' || b.category === 'v8') && b.self_ms > 0) cats.add(b.category);
	return [...cats];
}

export interface BudgetSeg {
	label: string;
	cat: FrameCategory;
	ms: number;
	pct: number;
}

/** The wall-clock triage bar: busy buckets + one canonical idle segment + an "other" remainder. */
export function budget_segments(a: Analysis): BudgetSeg[] {
	const dur = a.duration_ms || 1;
	const segs = a.buckets
		.filter((b) => b.self_ms > 0 && b.category !== 'idle')
		.map((b) => ({ label: b.key, cat: b.category, ms: b.self_ms }));
	if (a.idle_ms > 0) segs.push({ label: 'idle / waiting', cat: 'idle' as FrameCategory, ms: a.idle_ms });
	const acc = segs.reduce((s, x) => s + x.ms, 0);
	if (dur - acc > dur * 0.02)
		segs.push({ label: 'other', cat: 'unknown' as FrameCategory, ms: dur - acc });
	segs.sort((x, y) => y.ms - x.ms);
	return segs.map((s) => ({ ...s, pct: (s.ms / dur) * 100 }));
}

export interface WaitRow {
	caller: string;
	kind: string;
	count: number;
	ms: number;
	open: number;
}

/** Where the server WAITED, attributed to the function that started the I/O (net + async-hooks). */
export function waiting_rows(net: NetCall[], io: IoOp[]): WaitRow[] {
	const rows = new Map<string, WaitRow>();
	const add = (caller: string, kind: string, ms: number, open = false) => {
		const key = caller + '|' + kind;
		const r = rows.get(key) ?? { caller, kind, count: 0, ms: 0, open: 0 };
		r.count++;
		r.ms += ms;
		if (open) r.open++;
		rows.set(key, r);
	};
	for (const c of net) if (c.ms >= 0 && c.caller) add(c.caller, 'http', c.ms + (c.body_ms ?? 0));
	for (const o of io) if (o.caller && !o.open) add(o.caller, io_kind(o.type), o.ms);
	return [...rows.values()]
		.filter((r) => r.ms >= 0.5)
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 30);
}

export interface HostRow {
	host: string;
	count: number;
	total: number;
	p50: number;
	max: number;
	errors: number;
}

export function top_hosts(net: NetCall[]): HostRow[] {
	const by_host = new Map<string, number[]>();
	const errors = new Map<string, number>();
	for (const c of net) {
		const t = c.ms + (c.body_ms ?? 0);
		let list = by_host.get(c.host);
		if (!list) by_host.set(c.host, (list = []));
		list.push(t);
		if (c.error) errors.set(c.host, (errors.get(c.host) ?? 0) + 1);
	}
	return [...by_host.entries()]
		.map(([host, list]) => {
			const sorted = [...list].sort((a, b) => a - b);
			return {
				host,
				count: list.length,
				total: Math.round(list.reduce((a, c) => a + c, 0) * 100) / 100,
				p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
				max: sorted.at(-1) ?? 0,
				errors: errors.get(host) ?? 0
			};
		})
		.sort((a, b) => b.total - a.total);
}

export function short_url(url: string): string {
	try {
		const u = new URL(url);
		const path = u.pathname.length > 48 ? u.pathname.slice(0, 45) + '…' : u.pathname;
		return u.host + path + (u.search ? '?…' : '');
	} catch {
		return url.length > 64 ? url.slice(0, 61) + '…' : url;
	}
}

function wf_url(url: string): string {
	try {
		const u = new URL(url);
		const s = u.pathname + u.search;
		return s.length > 44 ? s.slice(0, 43) + '…' : s;
	} catch {
		return url.length > 44 ? url.slice(0, 43) + '…' : url;
	}
}

export interface WfRow {
	left: number;
	width: number;
	bodyPct: number;
	err: boolean;
	label: string;
	title: string;
	rightAnchored: boolean;
}

/** Network waterfall bars, spanned from the first call to the last call's end. */
export function waterfall_rows(net: NetCall[]): WfRow[] {
	if (net.length < 2 || net.length > 120) return [];
	const sorted = [...net].sort((a, b) => a.epoch - b.epoch);
	const t0 = sorted[0].epoch;
	const last_end = sorted.reduce((m, c) => Math.max(m, c.epoch + c.ms + (c.body_ms ?? 0)), 0);
	const span = Math.max(last_end - t0, 1);
	return sorted.map((c) => {
		const left = Math.max(0, ((c.epoch - t0) / span) * 100);
		const dur = c.ms + (c.body_ms ?? 0);
		const width = Math.min(100 - left, Math.max((dur / span) * 100, 0.3));
		return {
			left,
			width,
			bodyPct: dur > 0 && c.body_ms ? (c.body_ms / dur) * 100 : 0,
			err: !!c.error,
			title: c.url,
			label: `${c.method} ${wf_url(c.url)} — ${dur >= 100 ? dur.toFixed(0) : dur >= 10 ? dur.toFixed(1) : dur.toFixed(2)} ms`,
			rightAnchored: left + width > 62
		};
	});
}

export interface Spark {
	pts: string;
	min: number;
	max: number;
	w: number;
	h: number;
	pad: number;
	first: MemSample;
	last: MemSample;
}

/** Sparkline geometry for rss over the window. */
export function spark(mem: MemSample[]): Spark | null {
	if (mem.length < 3) return null;
	const w = 640,
		h = 64,
		pad = 4;
	const t_max = Math.max(mem.at(-1)!.t, 1);
	const values = mem.map((m) => m.rss);
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = Math.max(max - min, 1);
	const pts = mem
		.map((m) => `${pad + (m.t / t_max) * (w - 2 * pad)},${h - pad - ((m.rss - min) / range) * (h - 2 * pad)}`)
		.join(' ');
	return { pts, min, max, w, h, pad, first: mem[0], last: mem.at(-1)! };
}

export type { GroupStat };
