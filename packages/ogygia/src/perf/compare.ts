/**
 * COMPARE — a snapshot against a baseline under a budget, into a verdict a CI step can fail on.
 * Pure. The budget is relative (a page may grow 8 %) with an absolute floor (a 1 ms page cannot
 * fail on 1 ms of noise) and absolute caps where a number has a hard meaning (the seed must stay
 * under N KB). A page that is new (no baseline) is measured against the caps only.
 */
import type { PageSnapshot, PerfSnapshot } from './measure.js';

export interface Budget {
	/** the median render may grow this much, percent (default 8) */
	render_pct?: number;
	/** …but never fail on less than this many ms of growth (default 5) */
	render_floor_ms?: number;
	/** the median render must stay under this, ms (absolute; unset = no cap) */
	render_max_ms?: number;
	/** CPU busy may grow this much, percent (default 15) */
	busy_pct?: number;
	/** any one component's self time may grow this much, percent (default 25), floor 2 ms */
	component_pct?: number;
	/** the seed may grow this many KB (default 20), and must stay under `seed_max_kb` */
	seed_kb?: number;
	seed_max_kb?: number;
	/** island props may grow this many KB (default 30) */
	props_kb?: number;
	/** the islands' JS may grow this many KB (default 30), and must stay under `islands_js_max_kb` */
	islands_js_kb?: number;
	islands_js_max_kb?: number;
	/** the cold render's extra may grow this many ms (default 100) */
	cold_extra_ms?: number;
	/** finding codes that fail the build when they APPEAR (default: none) */
	fail_on?: string[];
	/** per-page overrides, keyed by page path */
	pages?: Record<string, Omit<Budget, 'pages'>>;
}

export const DEFAULT_BUDGET: Required<Omit<Budget, 'render_max_ms' | 'seed_max_kb' | 'islands_js_max_kb' | 'pages' | 'fail_on'>> & Pick<Budget, 'fail_on'> = {
	render_pct: 8,
	render_floor_ms: 5,
	busy_pct: 15,
	component_pct: 25,
	seed_kb: 20,
	props_kb: 30,
	islands_js_kb: 30,
	cold_extra_ms: 100,
	fail_on: []
};

export interface MetricRow {
	metric: string;
	unit: 'ms' | 'KB' | 'n';
	base: number | null;
	cur: number;
	/** cur − base; null for a new page */
	delta: number | null;
	pct: number | null;
	/** the budget this row is judged by, in words */
	limit: string;
	over: boolean;
}

export interface Mover {
	kind: 'component' | 'function' | 'path';
	name: string;
	file?: string;
	base: number;
	cur: number;
	delta: number;
	over: boolean;
}

export interface PageVerdict {
	page: string;
	/** no baseline for this page: judged by the caps only */
	fresh: boolean;
	rows: MetricRow[];
	movers: Mover[];
	/** warnings that appeared / went away */
	warnings: { added: string[]; gone: string[] };
	failures: string[];
}

export interface Verdict {
	ok: boolean;
	pages: PageVerdict[];
	/** pages in the baseline that the current snapshot did not measure */
	missing: string[];
	failures: string[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The budget for one page: defaults, the top level, then the page's overrides. */
function budget_for(page: string, budget: Budget): Required<Omit<Budget, 'pages'>> & { render_max_ms: number; seed_max_kb: number; islands_js_max_kb: number } {
	const { pages, ...top } = budget;
	const over = pages?.[page] ?? {};
	const merged = { ...DEFAULT_BUDGET, render_max_ms: Infinity, seed_max_kb: Infinity, islands_js_max_kb: Infinity, ...strip(top), ...strip(over) };
	return merged as ReturnType<typeof budget_for>;
}
const strip = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export function verdict(baseline: PerfSnapshot | null, current: PerfSnapshot, budget: Budget = {}): Verdict {
	const base_pages = new Map((baseline?.pages ?? []).map((p) => [p.page, p]));
	const pages: PageVerdict[] = current.pages.map((cur) => judge(cur, base_pages.get(cur.page) ?? null, budget_for(cur.page, budget)));
	const measured = new Set(current.pages.map((p) => p.page));
	const missing = [...base_pages.keys()].filter((p) => !measured.has(p));
	const failures = pages.flatMap((p) => p.failures.map((f) => `${p.page}: ${f}`));
	return { ok: failures.length === 0, pages, missing, failures };
}

function judge(cur: PageSnapshot, base: PageSnapshot | null, b: ReturnType<typeof budget_for>): PageVerdict {
	const rows: MetricRow[] = [];
	const failures: string[] = [];
	const row = (metric: string, unit: MetricRow['unit'], c: number, bv: number | null, judge_: (d: number | null, c: number) => { over: boolean; limit: string; why?: string }) => {
		const delta = bv === null ? null : r1(c - bv);
		const pct = bv === null || bv === 0 ? null : r1(((c - bv) / bv) * 100);
		const j = judge_(delta, c);
		rows.push({ metric, unit, base: bv, cur: r1(c), delta, pct, limit: j.limit, over: j.over });
		if (j.over) failures.push(j.why ?? `${metric} over budget`);
	};
	const grew = (delta: number | null, base_v: number | null, pct: number, floor: number) =>
		delta !== null && base_v !== null && delta > floor && delta > (base_v * pct) / 100;

	row('render (median)', 'ms', cur.render_p50, base?.render_p50 ?? null, (d, c) => {
		const rel = grew(d, base?.render_p50 ?? null, b.render_pct, b.render_floor_ms);
		const cap = c > b.render_max_ms;
		return {
			over: rel || cap,
			limit: `+${b.render_pct}% (≥ ${b.render_floor_ms} ms)${Number.isFinite(b.render_max_ms) ? `, max ${b.render_max_ms} ms` : ''}`,
			why: cap ? `render ${r1(c)} ms is over the ${b.render_max_ms} ms cap` : `render grew ${r1(d ?? 0)} ms (${b.render_pct}% allowed)`
		};
	});
	row('CPU busy', 'ms', cur.busy_ms, base?.busy_ms ?? null, (d) => ({
		over: grew(d, base?.busy_ms ?? null, b.busy_pct, b.render_floor_ms),
		limit: `+${b.busy_pct}%`,
		why: `CPU busy grew ${r1(d ?? 0)} ms (${b.busy_pct}% allowed)`
	}));
	row('waiting on calls', 'ms', cur.wait_ms, base?.wait_ms ?? null, () => ({ over: false, limit: 'informational' }));
	row('cold render extra', 'ms', cur.cold_extra_ms, base?.cold_extra_ms ?? null, (d) => ({
		over: d !== null && d > b.cold_extra_ms,
		limit: `+${b.cold_extra_ms} ms`,
		why: `the cold render's extra grew ${r1(d ?? 0)} ms (${b.cold_extra_ms} allowed)`
	}));
	row('page seed', 'KB', cur.seed_kb, base?.seed_kb ?? null, (d, c) => ({
		over: (d !== null && d > b.seed_kb) || c > b.seed_max_kb,
		limit: `+${b.seed_kb} KB${Number.isFinite(b.seed_max_kb) ? `, max ${b.seed_max_kb} KB` : ''}`,
		why: c > b.seed_max_kb ? `the seed is ${r1(c)} KB, over the ${b.seed_max_kb} KB cap` : `the seed grew ${r1(d ?? 0)} KB (${b.seed_kb} allowed)`
	}));
	row('island props', 'KB', cur.props_kb, base?.props_kb ?? null, (d) => ({
		over: d !== null && d > b.props_kb,
		limit: `+${b.props_kb} KB`,
		why: `island props grew ${r1(d ?? 0)} KB (${b.props_kb} allowed)`
	}));
	row('islands JS', 'KB', cur.islands_js_kb, base?.islands_js_kb ?? null, (d, c) => ({
		over: (d !== null && d > b.islands_js_kb) || c > b.islands_js_max_kb,
		limit: `+${b.islands_js_kb} KB${Number.isFinite(b.islands_js_max_kb) ? `, max ${b.islands_js_max_kb} KB` : ''}`,
		why: c > b.islands_js_max_kb ? `the islands load ${r1(c)} KB of JS, over the ${b.islands_js_max_kb} KB cap` : `the islands' JS grew ${r1(d ?? 0)} KB (${b.islands_js_kb} allowed)`
	}));
	row('islands', 'n', cur.islands, base?.islands ?? null, () => ({ over: false, limit: 'informational' }));

	// movers: components (by self), functions, paths — against the baseline's rows by name
	const movers: Mover[] = [];
	if (base) {
		const bc = new Map(base.components.map((c) => [c.name, c.self_ms]));
		for (const c of cur.components) {
			const bv = bc.get(c.name) ?? 0;
			const delta = r1(c.self_ms - bv);
			const over = bv > 0 && delta > 2 && delta > (bv * b.component_pct) / 100;
			if (Math.abs(delta) >= 0.5) movers.push({ kind: 'component', name: c.name, base: bv, cur: c.self_ms, delta, over });
			if (over) failures.push(`${c.name} self time grew ${delta} ms (${b.component_pct}% allowed)`);
		}
		const bf = new Map(base.functions.map((f) => [f.name + '|' + f.file, f.self_ms]));
		for (const f of cur.functions) {
			const bv = bf.get(f.name + '|' + f.file) ?? 0;
			const delta = r1(f.self_ms - bv);
			if (Math.abs(delta) >= 1) movers.push({ kind: 'function', name: f.name, file: f.file, base: bv, cur: f.self_ms, delta, over: false });
		}
		const bp = new Map(base.paths.map((p) => [p.owner, p.ms]));
		for (const p of cur.paths) {
			const bv = bp.get(p.owner) ?? 0;
			const delta = r1(p.ms - bv);
			if (Math.abs(delta) >= 1) movers.push({ kind: 'path', name: p.owner, base: bv, cur: p.ms, delta, over: false });
		}
		movers.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
	}
	const base_w = new Set(base?.warnings ?? []);
	const cur_w = new Set(cur.warnings);
	const added = [...cur_w].filter((w) => !base_w.has(w));
	const gone = [...base_w].filter((w) => !cur_w.has(w));
	for (const code of b.fail_on ?? []) if (added.includes(code) || (!base && cur_w.has(code))) failures.push(`finding ${code} appeared`);
	return { page: cur.page, fresh: !base, rows, movers: movers.slice(0, 12), warnings: { added, gone }, failures };
}
