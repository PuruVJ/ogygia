/**
 * COMPARE TWO REPORTS — before/after for a change. Pure data: rows keyed the way the tables key
 * them (component name; function key), deltas signed so a regression is positive, sorted by the
 * size of the change. Both reports are whatever is in the store: two page profiles of one route
 * are the intended pair, but any two work (the summary says what each is).
 */
import type { Analysis } from './analyze.js';
import type { ReportMeta } from './report.js';
import type { GcAttribution } from './gc.js';
import { PHASE_LABEL, type Phase } from './timeline.js';

export interface DeltaRow {
	name: string;
	/** where it lives (b's, else a's) */
	file: string;
	line: number;
	a_self: number;
	b_self: number;
	d_self: number;
	a_total: number;
	b_total: number;
	d_total: number;
	a_calls: number | null;
	b_calls: number | null;
	/** only in one side */
	only?: 'a' | 'b';
}

export interface SummaryRow {
	label: string;
	a: number;
	b: number;
	d: number;
	unit: 'ms' | 'n' | '%' | 'KB' | 'MB';
}

/** one allocation line before and after: what it allocated and the pause time it caused */
export interface GcMakerDelta {
	name: string;
	caller: string | null;
	component: string | null;
	a_mb: number;
	b_mb: number;
	d_mb: number;
	a_gc_ms: number;
	b_gc_ms: number;
	d_gc_ms: number;
	only?: 'a' | 'b';
}

export interface Comparison {
	a: { id: string; label: string; created: number };
	b: { id: string; label: string; created: number };
	summary: SummaryRow[];
	phases: { phase: Phase; label: string; a: number; b: number; d: number }[];
	components: DeltaRow[];
	functions: DeltaRow[];
	findings: { added: string[]; gone: string[] };
	/** the paths to fix, matched by their owner: what each path cost before and after */
	paths: PathDelta[];
	/** the garbage makers, matched by line: what each allocated and the GC it caused, before and after */
	gc_makers: GcMakerDelta[];
}

export interface PathDelta {
	owner: string;
	file: string;
	line: number;
	a_ms: number;
	b_ms: number;
	d_ms: number;
	a_fns: string[];
	b_fns: string[];
	only?: 'a' | 'b';
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : 0);

function label_of(m: ReportMeta): string {
	if (m.trigger === 'page') return `page ${m.page} ×${m.runs?.length ?? 0}`;
	if (m.trigger === 'request') return `request ${m.request?.path ?? ''}`;
	if (m.trigger === 'trap') return `caught ${m.request?.path ?? ''}`;
	return `${Math.round(m.duration_ms / 1000)}s window`;
}

function delta_rows(
	a: { key: string; name: string; url: string; line: number; self_ms: number; total_ms: number; calls?: number }[],
	b: typeof a,
	by: 'key' | 'name'
): DeltaRow[] {
	const map = new Map<string, DeltaRow>();
	for (const f of a) {
		map.set(f[by], {
			name: f.name,
			file: f.url,
			line: f.line,
			a_self: f.self_ms,
			b_self: 0,
			d_self: -f.self_ms,
			a_total: f.total_ms,
			b_total: 0,
			d_total: -f.total_ms,
			a_calls: f.calls ?? null,
			b_calls: null,
			only: 'a'
		});
	}
	for (const f of b) {
		const row = map.get(f[by]);
		if (row) {
			row.file = f.url;
			row.line = f.line;
			row.b_self = f.self_ms;
			row.b_total = f.total_ms;
			row.b_calls = f.calls ?? null;
			row.d_self = round2(f.self_ms - row.a_self);
			row.d_total = round2(f.total_ms - row.a_total);
			delete row.only;
		} else {
			map.set(f[by], {
				name: f.name,
				file: f.url,
				line: f.line,
				a_self: 0,
				b_self: f.self_ms,
				d_self: f.self_ms,
				a_total: 0,
				b_total: f.total_ms,
				d_total: f.total_ms,
				a_calls: null,
				b_calls: f.calls ?? null,
				only: 'b'
			});
		}
	}
	return [...map.values()].sort((x, y) => Math.abs(y.d_self) - Math.abs(x.d_self) || Math.abs(y.d_total) - Math.abs(x.d_total));
}

export function compare_reports(
	a: { meta: ReportMeta; analysis: Analysis; findings: string[]; gc?: GcAttribution },
	b: { meta: ReportMeta; analysis: Analysis; findings: string[]; gc?: GcAttribution }
): Comparison {
	const A = a.analysis;
	const B = b.analysis;
	// the garbage makers, matched by line (name + the app caller): allocated and GC caused, both sides
	const gc_makers = new Map<string, GcMakerDelta>();
	const mb = (n: number) => round2(n / 1048576);
	for (const m of a.gc?.makers ?? []) gc_makers.set(`${m.name}|${m.caller ?? ''}`, { name: m.name, caller: m.caller ?? null, component: m.component, a_mb: mb(m.allocated), b_mb: 0, d_mb: -mb(m.allocated), a_gc_ms: m.gc_ms, b_gc_ms: 0, d_gc_ms: -m.gc_ms, only: 'a' });
	for (const m of b.gc?.makers ?? []) {
		const k = `${m.name}|${m.caller ?? ''}`;
		const r = gc_makers.get(k);
		if (r) {
			r.b_mb = mb(m.allocated);
			r.d_mb = round2(r.b_mb - r.a_mb);
			r.b_gc_ms = m.gc_ms;
			r.d_gc_ms = round2(m.gc_ms - r.a_gc_ms);
			delete r.only;
		} else gc_makers.set(k, { name: m.name, caller: m.caller ?? null, component: m.component, a_mb: 0, b_mb: mb(m.allocated), d_mb: mb(m.allocated), a_gc_ms: 0, b_gc_ms: m.gc_ms, d_gc_ms: m.gc_ms, only: 'b' });
	}
	const row = (label: string, x: number, y: number, unit: SummaryRow['unit']): SummaryRow => ({
		label,
		a: round2(x),
		b: round2(y),
		d: round2(y - x),
		unit
	});
	const summary: SummaryRow[] = [];
	if (a.meta.trigger === 'page' && b.meta.trigger === 'page') {
		summary.push(row('render (median run)', median(a.meta.runs ?? []), median(b.meta.runs ?? []), 'ms'));
	} else if (a.meta.trigger === 'request' && b.meta.trigger === 'request') {
		summary.push(row('request', a.meta.request?.ms ?? 0, b.meta.request?.ms ?? 0, 'ms'));
	}
	summary.push(row('CPU busy', A.busy_ms, B.busy_ms, 'ms'));
	// GC: the observer's pauses with the profiler's share taken out when the attribution ran (the
	// precise number), else the sampler's GC frames — one number, the same one the report shows
	summary.push(row('garbage collection', a.gc?.summary.total_ms ?? A.gc_ms, b.gc?.summary.total_ms ?? B.gc_ms, 'ms'));
	if (a.gc || b.gc) summary.push(row('allocated in the window', a.gc?.summary.allocated_mb ?? 0, b.gc?.summary.allocated_mb ?? 0, 'MB'));
	if (A.timeline && B.timeline) {
		summary.push(row('waiting (I/O)', A.timeline.wait_ms, B.timeline.wait_ms, 'ms'));
	}
	const net_ms = (m: ReportMeta) => {
		const own = m.requests.filter((r) => r.internal || m.trigger !== 'page');
		return own.length ? Math.max(...own.map((r) => r.net_ms)) : 0;
	};
	const net_n = (m: ReportMeta) => {
		const own = m.requests.filter((r) => r.internal || m.trigger !== 'page');
		return own.length ? Math.max(...own.map((r) => r.net_count)) : 0;
	};
	summary.push(row('outbound calls', net_n(a.meta), net_n(b.meta), 'n'));
	summary.push(row('outbound time', net_ms(a.meta), net_ms(b.meta), 'ms'));
	const og = (m: ReportMeta) => m.requests.find((r) => r.og)?.og;
	const oa = og(a.meta);
	const ob = og(b.meta);
	if (oa || ob) {
		summary.push(row('ogygia transform', oa?.transform_ms ?? 0, ob?.transform_ms ?? 0, 'ms'));
		summary.push(row('page seed', (oa?.seed_bytes ?? 0) / 1024, (ob?.seed_bytes ?? 0) / 1024, 'KB'));
		summary.push(row('island props', (oa?.tail_bytes ?? 0) / 1024, (ob?.tail_bytes ?? 0) / 1024, 'KB'));
	}
	summary.push(row('components seen', A.components.length, B.components.length, 'n'));

	const phase_map = new Map<Phase, { a: number; b: number }>();
	for (const p of A.timeline?.phases ?? []) phase_map.set(p.phase, { a: p.cpu_ms + p.wait_ms, b: 0 });
	for (const p of B.timeline?.phases ?? []) {
		const r = phase_map.get(p.phase) ?? { a: 0, b: 0 };
		r.b = p.cpu_ms + p.wait_ms;
		phase_map.set(p.phase, r);
	}
	const phases = [...phase_map.entries()]
		.map(([phase, r]) => ({ phase, label: PHASE_LABEL[phase], a: round2(r.a), b: round2(r.b), d: round2(r.b - r.a) }))
		.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));

	const a_set = new Set(a.findings);
	const b_set = new Set(b.findings);
	// paths by owner name
	const paths = new Map<string, PathDelta>();
	for (const g of A.paths ?? []) paths.set(g.owner.name, { owner: g.owner.name, file: g.owner.url, line: g.owner.line, a_ms: g.ms, b_ms: 0, d_ms: -g.ms, a_fns: g.fns.map((f) => f.name), b_fns: [], only: 'a' });
	for (const g of B.paths ?? []) {
		const row = paths.get(g.owner.name);
		if (row) {
			row.b_ms = g.ms;
			row.d_ms = round2(g.ms - row.a_ms);
			row.b_fns = g.fns.map((f) => f.name);
			row.file = g.owner.url;
			row.line = g.owner.line;
			delete row.only;
		} else paths.set(g.owner.name, { owner: g.owner.name, file: g.owner.url, line: g.owner.line, a_ms: 0, b_ms: g.ms, d_ms: g.ms, a_fns: [], b_fns: g.fns.map((f) => f.name), only: 'b' });
	}
	return {
		a: { id: a.meta.id, label: label_of(a.meta), created: a.meta.created },
		b: { id: b.meta.id, label: label_of(b.meta), created: b.meta.created },
		summary,
		phases,
		components: delta_rows(A.components, B.components, 'name'),
		functions: delta_rows(A.functions.slice(0, 120), B.functions.slice(0, 120), 'key').slice(0, 60),
		findings: {
			added: b.findings.filter((f) => !a_set.has(f)),
			gone: a.findings.filter((f) => !b_set.has(f))
		},
		paths: [...paths.values()].sort((x, y) => Math.abs(y.d_ms) - Math.abs(x.d_ms)),
		gc_makers: [...gc_makers.values()].filter((m) => Math.abs(m.d_mb) >= 0.5 || Math.abs(m.d_gc_ms) >= 0.5).sort((x, y) => Math.abs(y.d_gc_ms) - Math.abs(x.d_gc_ms) || Math.abs(y.d_mb) - Math.abs(x.d_mb))
	};
}

/** Page-mode reports grouped by page, oldest first, with each run's median — the history line. */
export function page_history(
	metas: ReportMeta[]
): { page: string; points: { id: string; created: number; median: number }[] }[] {
	const by_page = new Map<string, { id: string; created: number; median: number }[]>();
	for (const m of metas) {
		if (m.trigger !== 'page' || !m.page || !m.runs?.length) continue;
		const list = by_page.get(m.page) ?? [];
		list.push({ id: m.id, created: m.created, median: round2(median(m.runs)) });
		by_page.set(m.page, list);
	}
	return [...by_page.entries()]
		.map(([page, points]) => ({ page, points: points.sort((x, y) => x.created - y.created) }))
		.filter((h) => h.points.length >= 1)
		.sort((x, y) => y.points.at(-1)!.created - x.points.at(-1)!.created);
}
