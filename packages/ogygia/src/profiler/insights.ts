/**
 * MORE FROM THE SAME SNAPSHOT — pure readings of a recording that need no new capture: the sync
 * I/O calls that blocked the event loop inside a render, the functions that look like they compute
 * the same thing many times per render (memoization candidates), and a WHAT-IF model over the
 * causality graph of the waits: the render's wall time with a call parallelized, cached or removed.
 */
import type { Analysis, FrameStat } from './analyze.js';
import type { AwaitNode, AwaitEdge } from './timeline.js';
import type { GcMaker } from './gc.js';
import type { SpanRecord } from './span.js';

// ── sync I/O ─────────────────────────────────────────────────────────────────────────────────

const SYNC_IO = new Set([
	'readFileSync',
	'writeFileSync',
	'appendFileSync',
	'readdirSync',
	'statSync',
	'lstatSync',
	'fstatSync',
	'existsSync',
	'accessSync',
	'mkdirSync',
	'rmSync',
	'rmdirSync',
	'unlinkSync',
	'copyFileSync',
	'realpathSync',
	'openSync',
	'readSync',
	'writeSync',
	'closeSync',
	'renameSync',
	'execSync',
	'execFileSync',
	'spawnSync',
	'gzipSync',
	'gunzipSync',
	'deflateSync',
	'inflateSync',
	'deflateRawSync',
	'inflateRawSync',
	'brotliCompressSync',
	'brotliDecompressSync',
	'pbkdf2Sync',
	'scryptSync',
	'hkdfSync',
	'generateKeyPairSync'
]);

export interface SyncIoRow {
	key: string;
	name: string;
	/** the node module (`node:fs`) */
	module: string;
	self_ms: number;
	total_ms: number;
	calls: number | null;
	/** the app frames that called it, nearest first, from its hottest stack */
	callers: string[];
}

/** Synchronous file, process, compression and key-derivation calls seen on the CPU during the
 *  window: each one blocks every other request on the instance for its whole length. */
export function sync_io(a: Analysis): SyncIoRow[] {
	const out: SyncIoRow[] = [];
	for (const f of a.functions) {
		if (!SYNC_IO.has(f.name)) continue;
		if (f.category !== 'node' && !f.url.startsWith('node:')) continue;
		const stack = (f.stacks ?? []).slice().sort((x, y) => y.ms - x.ms)[0];
		const callers = (stack?.frames ?? []).filter((fr) => fr.c === 'app' || fr.c === 'component').slice(0, 3).map((fr) => (fr.f ? `${fr.n} (${fr.f})` : fr.n));
		out.push({ key: f.key, name: f.name, module: f.url.startsWith('node:') ? f.url.split('/')[0] : f.url || 'node (native)', self_ms: f.self_ms, total_ms: f.total_ms, calls: f.calls ?? null, callers });
	}
	return out.sort((x, y) => y.total_ms - x.total_ms);
}

// ── memoization candidates ───────────────────────────────────────────────────────────────────

export interface MemoCandidate {
	key: string;
	name: string;
	url: string;
	line: number;
	/** calls in one render (coverage) */
	calls: number;
	total_ms: number;
	per_call_ms: number;
	/** bytes it allocated per call, when the allocation profile saw it */
	alloc_per_call?: number;
	/** the component most of its calls sat under */
	parent?: string;
}

const GLUE_RE = /^(?:\(anonymous\)|\$\.|get |set |render|children|slot|each_|if_|await_)/;
/** request handlers and loads run once per request by design: not candidates */
const HANDLER_NAMES = new Set(['load', 'handle', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'fetch', 'resolve']);
const is_handler_file = (url: string) => url.includes('hooks.server') || url.includes('+server.');

/** App functions called many times per render at a steady cost each: what a cache keyed on the
 *  argument would remove. Heuristic, from counts and cost alone: the report says so. */
export function memo_candidates(a: Analysis, makers: GcMaker[] = [], limit = 8): MemoCandidate[] {
	const runs = 1;
	const budget = Math.max(a.busy_ms, 1);
	// what the function allocated: the makers are the builtins it called (`structuredClone ←
	// toProductVM (lib/mappers.ts:26)`), so match on the caller it names, plus itself when it
	// allocates directly
	const base = (u: string) => u.split('/').pop() ?? u;
	const alloc_of = (f: FrameStat) => {
		const b = base(f.url);
		let sum = 0;
		for (const m of makers) {
			if (m.name === f.name && base(m.url) === b) sum += m.allocated;
			else if (m.caller && m.caller.startsWith(f.name + ' (') && m.caller.includes(b + ':')) sum += m.allocated;
		}
		return sum || undefined;
	};
	const out: MemoCandidate[] = [];
	for (const f of a.functions) {
		// a component renders once per item by design; the candidates are the app's own functions
		if (f.category !== 'app') continue;
		const calls = (f.calls ?? 0) / runs;
		if (calls < 10 || GLUE_RE.test(f.name) || HANDLER_NAMES.has(f.name) || is_handler_file(f.url)) continue;
		if (f.total_ms < Math.max(2, budget * 0.005)) continue;
		const per_call = f.total_ms / calls;
		if (per_call < 0.02) continue;
		const alloc = alloc_of(f);
		out.push({ key: f.key, name: f.name, url: f.url, line: f.line, calls: Math.round(calls), total_ms: f.total_ms, per_call_ms: Math.round(per_call * 1000) / 1000, ...(alloc ? { alloc_per_call: Math.round(alloc / calls) } : {}), ...(f.parent ? { parent: f.parent } : {}) });
	}
	return out.sort((x, y) => y.total_ms - x.total_ms).slice(0, limit);
}

// ── what if ──────────────────────────────────────────────────────────────────────────────────

export type WhatIf = 'parallel' | 'cache' | 'remove';

export interface Simulation {
	/** the render's wall as recorded and under the changes, ms */
	before_ms: number;
	after_ms: number;
	delta_ms: number;
	/** the longest chain of waits after the changes, in order */
	chain: string[];
	/** every node's new start and end */
	nodes: { label: string; t0: number; t1: number; moved: boolean }[];
}

/** The render under a set of changes to its calls. The model: a call with a predecessor (an
 *  edge: it started once the predecessor finished) starts when the predecessor ends plus the gap
 *  that sat between them; a call without one keeps its recorded start; the CPU after the last
 *  call keeps its length. `parallel` starts a call with its predecessor instead of after it,
 *  `cache` makes it instant, `remove` takes it out. A model of the waits, not of the CPU. */
export function simulate_awaits(nodes: AwaitNode[], edges: AwaitEdge[], window_ms: number, changes: Record<string, WhatIf>): Simulation {
	const idx = nodes.map((n, i) => ({ ...n, i })).sort((a, b) => a.t0 - b.t0);
	// predecessor of each node: the last node of the edge's `from` label that ended before it started
	const by_label = new Map<string, typeof idx>();
	for (const n of idx) (by_label.get(n.label) ?? by_label.set(n.label, []).get(n.label)!).push(n);
	const pred = new Map<number, { p: (typeof idx)[number]; gap: number }>();
	for (const e of edges) {
		for (const b of by_label.get(e.to) ?? []) {
			if (pred.has(b.i)) continue;
			let best: (typeof idx)[number] | undefined;
			for (const a of by_label.get(e.from) ?? []) if (a.t1 <= b.t0 + 0.05 && (!best || a.t1 > best.t1)) best = a;
			if (best) pred.set(b.i, { p: best, gap: e.gap_ms });
		}
	}
	const last_end = Math.max(0, ...nodes.map((n) => n.t1));
	const tail = Math.max(0, window_ms - last_end);
	const start = new Map<number, number>();
	const end = new Map<number, number>();
	const chain_of = new Map<number, string[]>();
	for (const n of idx) {
		const change = changes[n.label];
		const dur = change === 'cache' || change === 'remove' ? 0 : n.t1 - n.t0;
		const pr = pred.get(n.i);
		let t0: number;
		let chain: string[];
		if (pr && change !== 'remove') {
			const p_change = changes[pr.p.label];
			const p_start = start.get(pr.p.i) ?? pr.p.t0;
			const p_end = end.get(pr.p.i) ?? pr.p.t1;
			// a removed predecessor is not waited for; a parallelized call starts with its predecessor
			t0 = p_change === 'remove' ? Math.min(n.t0, p_start) : change === 'parallel' ? p_start : p_end + pr.gap;
			chain = [...(chain_of.get(pr.p.i) ?? [pr.p.label]), n.label];
		} else {
			t0 = n.t0;
			chain = [n.label];
		}
		start.set(n.i, t0);
		end.set(n.i, t0 + dur);
		chain_of.set(n.i, chain);
	}
	let after_last = 0;
	let longest: string[] = [];
	for (const n of idx) {
		if (changes[n.label] === 'remove') continue;
		const e = end.get(n.i)!;
		if (e > after_last) {
			after_last = e;
			longest = chain_of.get(n.i) ?? [];
		}
	}
	const after_ms = Math.round((after_last + tail) * 100) / 100;
	return {
		before_ms: window_ms,
		after_ms,
		delta_ms: Math.round((after_ms - window_ms) * 100) / 100,
		chain: longest,
		nodes: idx.map((n) => ({ label: n.label, t0: Math.round((start.get(n.i) ?? n.t0) * 100) / 100, t1: Math.round((end.get(n.i) ?? n.t1) * 100) / 100, moved: Math.abs((start.get(n.i) ?? n.t0) - n.t0) > 0.05 || (changes[n.label] !== undefined) }))
	};
}

// ── values, not just functions ───────────────────────────────────────────────────────────────

export interface SpanValueRow {
	span: string;
	attr: string;
	n: number;
	min: number;
	p50: number;
	max: number;
	sum: number;
	/** how the span's time moved with the value: ms per unit of the attribute (the slope of a
	 *  straight-line fit), when the value varied across at least 3 spans */
	ms_per_unit?: number;
	/** how well that line fits, -1..1 (near 1: the value drives the time) */
	r?: number;
}

/** The NUMBERS the app attached to its spans (`span('db.query', fn, (rows) => ({ rows:
 *  rows.length }))`): per span name and attribute, the range across the recording, and how
 *  the span's time moved with the value — the cost per row, per tag, per byte. What a
 *  function's name alone cannot say: the same function is cheap on 3 items and slow on 3000. */
export function span_values(spans: readonly SpanRecord[] | undefined): SpanValueRow[] {
	if (!spans?.length) return [];
	const by = new Map<string, { values: number[]; ms: number[] }>();
	for (const s of spans) {
		if (!s.attrs || s.ms < 0) continue;
		for (const k in s.attrs) {
			const v = s.attrs[k];
			if (typeof v !== 'number' || !Number.isFinite(v)) continue;
			const key = s.name + '\0' + k;
			let e = by.get(key);
			if (!e) by.set(key, (e = { values: [], ms: [] }));
			e.values.push(v);
			e.ms.push(s.ms);
		}
	}
	const out: SpanValueRow[] = [];
	for (const [key, e] of by) {
		const at = key.indexOf('\0');
		const sorted = [...e.values].sort((a, b) => a - b);
		const n = sorted.length;
		const sum = sorted.reduce((a, b) => a + b, 0);
		const row: SpanValueRow = { span: key.slice(0, at), attr: key.slice(at + 1), n, min: sorted[0], p50: sorted[n >> 1], max: sorted[n - 1], sum: Math.round(sum * 1000) / 1000 };
		// a fit needs the value to have moved: a spread under 5% of its size is noise, not a slope
		if (n >= 3 && sorted[n - 1] - sorted[0] >= Math.abs(sorted[n - 1]) * 0.05) {
			const mx = sum / n;
			const my = e.ms.reduce((a, b) => a + b, 0) / n;
			let sxy = 0;
			let sxx = 0;
			let syy = 0;
			for (let i = 0; i < n; i++) {
				const dx = e.values[i] - mx;
				const dy = e.ms[i] - my;
				sxy += dx * dy;
				sxx += dx * dx;
				syy += dy * dy;
			}
			if (sxx > 0) {
				row.ms_per_unit = Math.round((sxy / sxx) * 10000) / 10000;
				row.r = syy > 0 ? Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100 : 0;
			}
		}
		out.push(row);
	}
	return out.sort((a, b) => b.n - a.n || a.span.localeCompare(b.span));
}

// ── what a render leaves behind ──────────────────────────────────────────────────────────────

export interface RetainedSite {
	name: string;
	url: string;
	line: number;
	caller?: string;
	component: string | null;
	bytes: number;
	share: number;
}

export interface Retained {
	/** bytes still alive after one more render and a full collection */
	total_bytes: number;
	render_ms: number;
	sites: RetainedSite[];
}
