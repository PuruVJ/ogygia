/**
 * COMPARE TWO REPORTS — before/after for a change. Pure data: rows keyed the way the tables key
 * them (component name; function key), deltas signed so a regression is positive, sorted by the
 * size of the change. Both reports are whatever is in the store: two page profiles of one route
 * are the intended pair, but any two work (the summary says what each is).
 */
import type { Analysis } from './analyze.js';
import type { ReportMeta } from './report.js';
import { own_requests } from './own-requests.js';
import type { VitalMove } from '../devtools/page-insights.js';
import type { GcAttribution } from './gc.js';
import type { Pattern, PatternKind } from './patterns.js';
import type { LedgerLine } from './ledger.js';
import { at_line, type DrillNode } from './drill.js';
import type { Forecast } from './forecast.js';
// (the arithmetic alone: compare runs in the browser too, and the forecast module reads sources)
import { saving_of } from './saving.js';
import { PHASE_LABEL, type Phase } from './timeline.js';

export interface DeltaRow {
	/** the identity both sides were matched on (unique in its list: what a view keys rows by —
	 *  two anonymous functions in one file share a name and a file) */
	key: string;
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
	/** the slow patterns, matched by kind (and library): which a change fixed, which it introduced */
	patterns: PatternDelta[];
	/** DID THE FIX PAY: what the patterns that went away or got better were expected to save, per
	 *  render, against how much faster the median render actually got (page mode, both sides) */
	fix_check?: {
		predicted_ms: number;
		measured_ms: number;
		verdict: 'as-expected' | 'less' | 'more';
		/** B ran after A on the heap A filled (`order`): its render reads slow, the measured saving low */
		skewed?: true;
	};
	/** the costly app lines, matched by file + code (an edit above them moves the number, not the
	 *  code), per render on each side: what the change did to each */
	lines: LineDelta[];
	/** WHERE ONE RENDER'S TIME MOVED: the drill-down rows that changed, deepest cause only */
	drill?: DrillDelta[];
	/** THE RUN ORDER TRAP: both ran on one server, and the earlier one saw every render keep memory
	 *  alive — the later one ran on a fuller heap (more GC, slower allocation), so part of its
	 *  difference is the order, not the code */
	order?: { earlier: 'a' | 'b'; kept_mb: number; requests_between: number };
	/** the render took the same time on both sides (within the runs' own spread): CPU moves between
	 *  patterns and lines are V8 charging the time elsewhere (inlining differs run to run), so they
	 *  read `shifted`, not fixed or worse */
	render_same?: { a_ms: number; b_ms: number; noise_ms: number };
}

export interface LineDelta {
	file: string;
	/** the line number in b (a's when the line is gone) */
	line: number;
	code: string;
	/** CPU per render (own + inside libraries), ms */
	a_ms: number;
	b_ms: number;
	d_ms: number;
	/** bytes made per render */
	a_bytes: number;
	b_bytes: number;
	/** bytes kept alive per render */
	a_kept: number;
	b_kept: number;
	status: 'fixed' | 'new' | 'better' | 'worse' | 'same' | 'shifted';
}

/** The render's own noise decides: both reports' runs, the median moved no more than their spread
 *  (or 3 %). Then the CPU rows' moves are attribution, not change. */
function render_same_of(a: ReportMeta, b: ReportMeta): { render_same?: Comparison['render_same'] } {
	const ra = a.runs ?? [];
	const rb = b.runs ?? [];
	if (ra.length < 2 || rb.length < 2) return {};
	const spread = (r: number[]) => Math.max(...r) - Math.min(...r);
	const ma = median(ra);
	const mb = median(rb);
	const noise = Math.max(spread(ra), spread(rb), 0.03 * Math.max(ma, mb));
	return Math.abs(mb - ma) <= noise
		? { render_same: { a_ms: round2(ma), b_ms: round2(mb), noise_ms: round2(noise) } }
		: {};
}

/** With the render unchanged, a CPU row's fixed / new / better / worse is where V8 charged the time. */
export function mark_shifted(cmp: Comparison): Comparison {
	if (!cmp.render_same) return cmp;
	for (const p of cmp.patterns)
		if (
			p.status !== 'same' &&
			!p.wait &&
			p.kind !== 'kept-per-render' &&
			p.kind !== 'seed-whole-read'
		)
			p.status = 'shifted';
	// a line whose kept memory moved keeps its verdict: memory is not re-attributed by inlining
	for (const l of cmp.lines)
		if (l.status !== 'same' && Math.abs(l.b_kept - l.a_kept) < 128 * 1024) l.status = 'shifted';
	// the drill's CPU rows and lines under them likewise; waits and gaps keep theirs
	for (const r of cmp.drill ?? [])
		if ((r.kind === 'cpu' || r.kind === 'line') && !r.waiting) r.status = 'shifted';
	// shifted rows go last, the real moves first
	if (cmp.drill)
		cmp.drill.sort(
			(x, y) =>
				Number(x.status === 'shifted') - Number(y.status === 'shifted') ||
				Math.abs(y.d_ms) - Math.abs(x.d_ms)
		);
	return cmp;
}

const renders_of = (m: ReportMeta) => (m.trigger === 'page' ? Math.max(1, m.runs?.length ?? 1) : 1);

/** The two ledgers side by side. Keyed by file + the code on the line: code that changed reads as
 *  one line gone and another new (the fix), code that did not keeps its row though its number moved. */
export function line_deltas(
	a: readonly LedgerLine[] = [],
	b: readonly LedgerLine[] = [],
	ra = 1,
	rb = 1
): LineDelta[] {
	const key = (l: LedgerLine) => l.file + '\0' + (l.code ?? `#${l.line}`);
	const cost = (l: LedgerLine, r: number) => ({
		ms: round2((l.cpu_ms + l.lib_ms) / r),
		bytes: Math.round(l.alloc_bytes / r),
		kept: l.retained_bytes
	});
	const out = new Map<string, LineDelta>();
	for (const l of a) {
		const c = cost(l, ra);
		out.set(key(l), {
			file: l.file,
			line: l.line,
			code: l.code ?? '',
			a_ms: c.ms,
			b_ms: 0,
			d_ms: -c.ms,
			a_bytes: c.bytes,
			b_bytes: 0,
			a_kept: c.kept,
			b_kept: 0,
			status: 'fixed'
		});
	}
	for (const l of b) {
		const c = cost(l, rb);
		const r = out.get(key(l));
		if (!r) {
			out.set(key(l), {
				file: l.file,
				line: l.line,
				code: l.code ?? '',
				a_ms: 0,
				b_ms: c.ms,
				d_ms: c.ms,
				a_bytes: 0,
				b_bytes: c.bytes,
				a_kept: 0,
				b_kept: c.kept,
				status: 'new'
			});
			continue;
		}
		Object.assign(r, {
			line: l.line,
			b_ms: c.ms,
			d_ms: round2(c.ms - r.a_ms),
			b_bytes: c.bytes,
			b_kept: c.kept
		});
		// a real move: a fifth of the time and 1 ms, or half the bytes (made or kept)
		const t = Math.abs(r.d_ms) >= Math.max(0.2 * r.a_ms, 1);
		const m =
			Math.abs(c.bytes - r.a_bytes) >= 0.5 * Math.max(r.a_bytes, 1) &&
			Math.abs(c.bytes - r.a_bytes) >= 256 * 1024;
		const k =
			Math.abs(c.kept - r.a_kept) >= 0.5 * Math.max(r.a_kept, 1) &&
			Math.abs(c.kept - r.a_kept) >= 128 * 1024;
		const worse = r.d_ms > 0 || c.bytes > r.a_bytes || c.kept > r.a_kept;
		r.status = !(t || m || k) ? 'same' : worse && !(r.d_ms < 0 && t) ? 'worse' : 'better';
	}
	// a line that left the ledger was either fixed or just fell below its top 40: only a line
	// that cost something is called fixed, the rest drop out of the table
	const rank = { fixed: 0, new: 1, worse: 2, better: 3, shifted: 4, same: 5 };
	// (the same for a line that joined: a cheap one only moved into the top 40)
	const costly = (ms: number, bytes: number, kept: number) =>
		ms >= 1 || bytes >= 1024 * 1024 || kept >= 256 * 1024;
	return [...out.values()]
		.filter(
			(r) =>
				(r.status !== 'fixed' || costly(r.a_ms, r.a_bytes, r.a_kept)) &&
				(r.status !== 'new' || costly(r.b_ms, r.b_bytes, r.b_kept))
		)
		.sort((x, y) => rank[x.status] - rank[y.status] || Math.abs(y.d_ms) - Math.abs(x.d_ms))
		.slice(0, 40);
}

/** A report against the previous profile of its page, cut for the top of the report: the render's
 *  change, the drill rows that really moved (inlining shifts left out), the order trap, the fix check */
export interface Since {
	prev: string;
	a_ms?: number;
	b_ms?: number;
	/** the render took the same time within the runs' own spread */
	same?: boolean;
	moved: DrillDelta[];
	order?: Comparison['order'];
	fix_check?: Comparison['fix_check'];
	/** the page score then and now, and the categories that moved it most */
	score?: {
		a: number;
		b: number;
		a_grade: string;
		b_grade: string;
		moved: { key: string; label: string; a: number; b: number }[];
	};
	/** what changed in the page's JS between the two builds (both weighed): the files behind a JS move */
	assets?: import('./page-assets.js').AssetsDiff;
	/** the browser's findings fixed and new (both reports with a visit), as `code (islands)` */
	browser?: { fixed: string[]; added: string[] };
	/** which islands changed file between the two builds (what a returning visitor downloads again) */
	islands?: IslandFilesDiff;
	/** the browser's vitals that moved (each report's own visit), and for TTFB / FCP / LCP the part
	 *  of it that moved most — "LCP 1.2 s → 2.6 s: its download 300 → 1700 ms" */
	vitals?: VitalMove[];
}

// (the vitals that moved: ONE rule, shared with the Page tab's "since your last load")
export { vitals_moved, type VitalMove } from '../devtools/page-insights.js';

/**
 * WHAT A DEPLOY COSTS A RETURNING VISITOR. Each island's file is named by its content, so between two
 * profiles of one page an island either KEPT its file (a returning visitor's cache still serves it) or
 * MOVED to a new one (downloaded again). Islands keyed by identity (`entry`), files by location
 * (`module_url`); `bytes` weighs a moved island's new file when the second build weighed it.
 * `all_moved`: every island moved — when their code did not all change, the build's names are not
 * stable (SvelteKit bakes its version, the build time by default, into its client chunk: pin
 * `kit.version.name`). Null when there is nothing to compare (a page without islands, or a build from
 * before content hashing, where a file's name never moved).
 */
export interface IslandFilesDiff {
	moved: { name: string; bytes: number | null }[];
	kept: number;
	/** the moved files' bytes, where weighed */
	bytes: number;
	all_moved: boolean;
}

export function island_files_diff(
	a: readonly { entry: string; name: string; module_url: string }[],
	b: readonly { entry: string; name: string; module_url: string }[],
	weight?: (url: string) => number | undefined
): IslandFilesDiff | null {
	const before = new Map(a.map((r) => [r.entry, r.module_url]));
	const moved: IslandFilesDiff['moved'] = [];
	let kept = 0;
	const seen = new Set<string>();
	for (const r of b) {
		if (seen.has(r.entry)) continue;
		seen.add(r.entry);
		const was = before.get(r.entry);
		// (a build from before content hashing loads the identity itself: its name never moved)
		if (was === undefined || was === r.entry || r.module_url === r.entry) continue;
		if (was === r.module_url) kept++;
		else moved.push({ name: r.name, bytes: weight?.(r.module_url) ?? null });
	}
	if (!moved.length && !kept) return null;
	return {
		moved,
		kept,
		bytes: moved.reduce((s, m) => s + (m.bytes ?? 0), 0),
		all_moved: moved.length >= 3 && kept === 0
	};
}

export interface DrillDelta {
	/** the row's place in the render, top down: `load functions › +page.server.ts › GET api/x` */
	path: string[];
	kind: DrillNode['kind'];
	at?: string;
	a_ms: number;
	b_ms: number;
	d_ms: number;
	/** that side had no row of its own, only an "N more" fold: its ms is the fold's, an upper bound */
	upto?: 'a' | 'b';
	/** a wait, a gap, or a line under one: clock time, never re-attributed by inlining */
	waiting?: boolean;
	/** `shifted`: the render took the same time on both sides, so a CPU row's move is V8 charging the
	 *  time to another function (inlining differs run to run), not a change */
	status: 'fixed' | 'new' | 'better' | 'worse' | 'shifted';
}

/** memory kept per render that slows the renders after it on the same server */
const ORDER_KEPT_BYTES = 8 * 1024 * 1024;

/** One server for both (its start, from each report's time and the server's age then, within the
 *  length of a profile; and it had served more requests by the later one), and the earlier report
 *  saw each render keep 8 MB+ alive: the later one inherited the fuller heap. */
export function order_of(
	a: { meta: ReportMeta; patterns?: readonly Pattern[] },
	b: { meta: ReportMeta; patterns?: readonly Pattern[] }
): Comparison['order'] {
	const ia = a.meta.instance;
	const ib = b.meta.instance;
	if (!ia || !ib) return undefined;
	const start = (m: ReportMeta, age_s: number) => m.created - age_s * 1000;
	if (Math.abs(start(a.meta, ia.age_s) - start(b.meta, ib.age_s)) > 30_000) return undefined;
	const [first, second, earlier] =
		a.meta.created <= b.meta.created ? [a, b, 'a' as const] : [b, a, 'b' as const];
	const between =
		(second.meta.instance!.requests_before ?? 0) - (first.meta.instance!.requests_before ?? 0);
	if (between <= 0) return undefined;
	const kept = first.patterns?.find((p) => p.kind === 'kept-per-render')?.kept_bytes ?? 0;
	if (kept < ORDER_KEPT_BYTES) return undefined;
	return { earlier, kept_mb: Math.round((kept / 1048576) * 10) / 10, requests_between: between };
}

/** a move worth naming: 2 ms and a fifth of the row (one render per side, so small moves are noise) */
const drill_moved = (a: number, b: number) => Math.abs(b - a) >= Math.max(2, 0.2 * Math.max(a, b));

/**
 * THE DRILL-DOWNS SIDE BY SIDE: every row of one render's tree matched by its place (phase › load
 * file › who › line), and the rows that moved — only the DEEPEST of a chain: a row whose moved
 * children carry most (70 %) of its move is left out, so the list names the cause (the call, the
 * line), not every level above it. Both trees are one render, so no per-render division.
 */
export function drill_deltas(a: DrillNode | undefined, b: DrillNode | undefined): DrillDelta[] {
	if (!a || !b) return [];
	type Row = {
		path: string[];
		kind: DrillNode['kind'];
		at?: string;
		a: number;
		b: number;
		kids: string[];
		parent?: string;
		folded: { a: number; b: number };
		upto?: 'a' | 'b';
		runs_a?: [number, number];
		runs_b?: [number, number];
		waiting?: boolean;
		code_a?: string;
		code_b?: string;
	};
	const rows = new Map<string, Row>();
	const walk = (n: DrillNode, path: string[], side: 'a' | 'b', parent?: string): string => {
		const k = path.join('\0');
		const r =
			rows.get(k) ??
			rows
				.set(k, {
					path,
					kind: n.kind,
					...(n.at ? { at: n.at } : {}),
					a: 0,
					b: 0,
					kids: [],
					...(parent ? { parent } : {}),
					folded: { a: 0, b: 0 }
				})
				.get(k)!;
		r[side] += n.ms;
		if (n.runs) r[side === 'a' ? 'runs_a' : 'runs_b'] = n.runs;
		if (n.code) r[side === 'a' ? 'code_a' : 'code_b'] = n.code;
		// a wait, a gap, or a line under one: time on the clock, not CPU V8 can re-attribute
		if (n.kind === 'wait' || n.kind === 'gap' || (parent ? rows.get(parent)?.waiting : false))
			r.waiting = true;
		if (n.at) r.at = n.at;
		for (const c of n.children ?? []) {
			// "N more" rows are a different set on each side: its folded rows (kept inside it) are the
			// parent's own children; an older report that dropped them leaves a fold a missing row may
			// sit in (when the fold is big enough)
			if (c.kind === 'more') {
				if (!c.children?.length) r.folded[side] = c.ms;
				for (const f of c.children ?? []) {
					const fk = walk(f, [...path, f.label], side, k);
					if (!r.kids.includes(fk)) r.kids.push(fk);
				}
				continue;
			}
			const ck = walk(c, [...path, c.label], side, k);
			if (!r.kids.includes(ck)) r.kids.push(ck);
		}
		return k;
	};
	const top: Row = { path: [], kind: 'render', a: 0, b: 0, kids: [], folded: { a: 0, b: 0 } };
	rows.set('', top);
	for (const [side, root] of [
		['a', a],
		['b', b]
	] as const) {
		for (const c of root.children ?? []) {
			if (c.kind !== 'more') walk(c, [c.label], side, '');
			else if (!c.children?.length) top.folded[side] = c.ms;
			else for (const f of c.children) walk(f, [f.label], side, '');
		}
	}
	rows.delete('');
	// A LINE THAT MOVED: an edit above a line renumbers it, and its row reads as one line gone and
	// another new. Paired BEFORE anything is judged (before a fold is suspected of hiding either), a
	// moved line is one row (its own change, if it has one, stays) and its parent's move is weighed
	// against that. Paired: under the same parent (one already paired counts as the same), in the
	// same file within 40 lines, the closest — with the same code when both reports carry it, else
	// about as costly (within a fifth, or 2 ms)
	const into = new Map<string, string>();
	const lines = [...rows.entries()]
		.filter(([, r]) => r.kind === 'line')
		.sort(([, x], [, y]) => x.path.length - y.path.length);
	const same_parent = (x: Row, y: Row) => (into.get(x.parent ?? '') ?? x.parent) === y.parent;
	const paired = new Set<string>();
	for (const [fk, f] of lines) {
		if (f.a < 0.05 || f.b >= 0.05) continue;
		const fl = f.at ? at_line(f.at) : undefined;
		if (!fl) continue;
		let best: string | undefined;
		let best_d = Infinity;
		for (const [nk, n] of lines) {
			if (n.a >= 0.05 || n.b < 0.05 || paired.has(nk) || !same_parent(f, n)) continue;
			const nl = n.at ? at_line(n.at) : undefined;
			if (!nl || nl.file !== fl.file) continue;
			const dist = Math.abs(nl.line - fl.line);
			if (dist > 40 || dist >= best_d) continue;
			if (
				f.code_a && n.code_b ? f.code_a !== n.code_b : Math.abs(n.b - f.a) > Math.max(2, 0.2 * f.a)
			)
				continue;
			best = nk;
			best_d = dist;
		}
		if (!best) continue;
		const n = rows.get(best)!;
		paired.add(best);
		into.set(fk, best);
		n.a = f.a;
		if (f.runs_a) n.runs_a = f.runs_a;
	}
	// missing on a side whose parent folded rows away: it may sit in the fold, so it is AT MOST the
	// fold's ms there — taken at that bound (the smallest move it can be), never read as gone
	for (const [k, r] of rows) {
		if (into.has(k)) continue;
		for (const side of ['a', 'b'] as const) {
			if (r[side] >= 0.05) continue;
			const fold = (r.parent === undefined ? top : rows.get(r.parent))?.folded[side] ?? 0;
			if (fold <= 0) continue;
			r[side] = Math.min(fold, side === 'a' ? r.b : r.a);
			r.upto = side;
		}
	}
	// with both sides' spreads over their renders, a move is one whose ranges do not overlap (and
	// 2 ms at least): the row's own noise decides, not a fixed share
	const moved = (r: Row) => {
		if (r.runs_a && r.runs_b) {
			const [a0, a1] = r.runs_a;
			const [b0, b1] = r.runs_b;
			return (a1 < b0 || b1 < a0) && Math.abs(r.b - r.a) >= 2;
		}
		return drill_moved(r.a, r.b);
	};
	const out: DrillDelta[] = [];
	for (const [k, r] of rows) {
		if (into.has(k) || !moved(r)) continue;
		const d = r.b - r.a;
		// the moved children that move the same way: when they carry most of it, they are the cause
		const kids = r.kids
			.filter((c) => !into.has(c))
			.map((c) => rows.get(c)!)
			.filter((c) => Math.sign(c.b - c.a) === Math.sign(d));
		const carried = kids.filter((c) => moved(c)).reduce((s, c) => s + (c.b - c.a), 0);
		if (Math.abs(carried) >= 0.7 * Math.abs(d)) continue;
		// ...or children whose own spreads call their change noise: then so is this row's
		const noise = kids
			.filter((c) => c.runs_a && c.runs_b && !moved(c))
			.reduce((s, c) => s + (c.b - c.a), 0);
		if (Math.abs(noise) >= 0.7 * Math.abs(d)) continue;
		out.push({
			path: r.path,
			kind: r.kind,
			...(r.at ? { at: r.at } : {}),
			a_ms: round2(r.a),
			b_ms: round2(r.b),
			d_ms: round2(d),
			...(r.upto ? { upto: r.upto } : {}),
			...(r.waiting ? { waiting: true } : {}),
			status: r.a < 0.05 ? 'new' : r.b < 0.05 ? 'fixed' : d < 0 ? 'better' : 'worse'
		});
	}
	return out.sort((x, y) => Math.abs(y.d_ms) - Math.abs(x.d_ms)).slice(0, 20);
}

export interface PatternDelta {
	/** the title as the newer report words it (the older one's when it is gone) */
	title: string;
	kind: PatternKind;
	/** measured cost on each side (CPU + GC, or waiting for a wait pattern), ms per render */
	a_ms: number;
	b_ms: number;
	d_ms: number;
	/** what fixing it was expected to save, each side, ms per render */
	a_save: number;
	b_save: number;
	a_sites: number;
	b_sites: number;
	/** fixed: gone in b · new: only in b · better / worse: cost moved by a fifth and 2 ms or more · same */
	status: 'fixed' | 'new' | 'better' | 'worse' | 'same' | 'shifted';
	wait?: boolean;
}

/** what makes two reports' patterns the same one: its kind, and for a library call the library */
const pattern_key = (p: Pattern) =>
	p.kind + '\0' + (p.kind === 'library-per-item' ? (p.sites[0]?.libs?.[0] ?? '') : '');

export function pattern_deltas(
	a: readonly Pattern[] = [],
	b: readonly Pattern[] = [],
	ra = 1,
	rb = 1
): PatternDelta[] {
	const out = new Map<string, PatternDelta>();
	// PER RENDER: a CPU pattern's cost and saving add up every profiled render; a wait's are one render
	const cost = (p: Pattern, r: number) => round2(p.wait ? p.cost_ms : p.cost_ms / r);
	const save = (p: Pattern, r: number) => round2(p.wait ? p.save_ms : p.save_ms / r);
	for (const p of a) {
		const c = cost(p, ra);
		out.set(pattern_key(p), {
			title: p.title,
			kind: p.kind,
			a_ms: c,
			b_ms: 0,
			d_ms: -c,
			a_save: save(p, ra),
			b_save: 0,
			a_sites: p.sites.length,
			b_sites: 0,
			status: 'fixed',
			...(p.wait ? { wait: true } : {})
		});
	}
	for (const p of b) {
		const r = out.get(pattern_key(p));
		const c = cost(p, rb);
		if (!r) {
			out.set(pattern_key(p), {
				title: p.title,
				kind: p.kind,
				a_ms: 0,
				b_ms: c,
				d_ms: c,
				a_save: 0,
				b_save: save(p, rb),
				a_sites: 0,
				b_sites: p.sites.length,
				status: 'new',
				...(p.wait ? { wait: true } : {})
			});
			continue;
		}
		r.title = p.title;
		r.b_ms = c;
		r.d_ms = round2(c - r.a_ms);
		r.b_save = save(p, rb);
		r.b_sites = p.sites.length;
		// run-to-run noise moves a pattern's cost by a tenth easily: a change must clear a fifth of
		// it AND 2 ms to count as one
		const moved = Math.abs(r.d_ms) >= Math.max(0.2 * r.a_ms, 2);
		r.status = !moved ? 'same' : r.d_ms < 0 ? 'better' : 'worse';
	}
	const rank = { fixed: 0, new: 1, worse: 2, better: 3, shifted: 4, same: 5 };
	// a pattern near the reporting floor comes and goes between runs of the same code: one that
	// "appears" or "disappears" at under 3 ms is noise, not a fix
	for (const r of out.values())
		if ((r.status === 'fixed' || r.status === 'new') && Math.max(r.a_ms, r.b_ms) < 3 && !r.wait)
			r.status = 'same';
	return [...out.values()].sort(
		(x, y) => rank[x.status] - rank[y.status] || Math.abs(y.d_ms) - Math.abs(x.d_ms)
	);
}

/** what the fixed and improved patterns promised, without the older report's forecast: not added up
 *  blindly — a whole-page cache's "saving" IS the render (it tracks any change), and wait patterns
 *  cover the SAME calls (one call made faster shrinks "same answer", "waits in a row" and "one slow
 *  call" at once), so the waits promise their largest move, CPU patterns their sum */
function summed_promise(patterns: readonly PatternDelta[]): number {
	let cpu = 0;
	let wait = 0;
	for (const p of patterns) {
		if (p.status !== 'fixed' && p.status !== 'better') continue;
		if (p.kind === 'same-document' || p.kind === 'almost-same-document') continue;
		const d = Math.max(0, p.a_save - p.b_save);
		if (p.wait) wait = Math.max(wait, d);
		else cpu += d;
	}
	return cpu + wait;
}

/** a title without its "(3 places)": the count changes when a fix shrinks a pattern */
const bare_title = (t: string) => {
	const i = t.lastIndexOf(' (');
	return i !== -1 && (t.endsWith(' places)') || t.endsWith(' place)')) ? t.slice(0, i) : t;
};

/**
 * WHAT THE CHANGE PROMISED, COUNTED THE FORECAST'S WAY: the older report's forecast parts that got
 * done — a part whose fix (or one it covers) went away counts whole, one that shrank by its share,
 * work for unread data when the newer report no longer has it — added with the same overlap rules
 * and caps as the forecast itself. The forecast was held to account against fixed pages; this is
 * the same arithmetic for the fix you actually made.
 */
/**
 * HOW MUCH OF EACH OLDER PATTERN IS STILL THERE, BY ITS OWN SITES: the share of its cost on sites
 * whose code the newer report still flags with the same kind (matched by the code, not the line
 * number an edit above moves). "Waits in a row" in both reports can be two different sets of calls —
 * the chains fixed, a new one between the batches — and its title alone would say it only shrank.
 */
export function still_there(
	a: readonly Pattern[] | undefined,
	b: readonly Pattern[] | undefined
): Map<string, number> {
	const out = new Map<string, number>();
	const code_of = (s: Pattern['sites'][number]) => (s.code ?? '').trim();
	const cost = (s: Pattern['sites'][number]) => s.wait_ms ?? s.cpu_ms ?? 0;
	for (const p of a ?? []) {
		const left = new Set(
			(b ?? []).filter((q) => q.kind === p.kind).flatMap((q) => q.sites.map(code_of))
		);
		// only sites that carry their code can be told gone: one without (no source on the host) says
		// nothing either way, and none at all means no verdict
		const coded = p.sites.filter((s) => code_of(s));
		const total = coded.reduce((t, s) => t + cost(s), 0);
		if (!(total > 0)) continue;
		const kept = coded.filter((s) => left.has(code_of(s))).reduce((t, s) => t + cost(s), 0);
		out.set(bare_title(p.title), kept / total);
	}
	return out;
}

function promised_by(
	fa: Forecast,
	fb: Forecast | undefined,
	patterns: readonly PatternDelta[],
	left?: Map<string, number>,
	b_clean = false
): number {
	const find = (title: string) => patterns.find((p) => bare_title(p.title) === bare_title(title));
	// the unread work the newer report still has: as a part of its own, folded into another part
	// (`with`), or among the answers' parts. A newer page report with no forecast at all has none left
	const still_unread = new Set<string>();
	const is_unread = (t: string) => t.startsWith('Delete work for data nothing reads');
	for (const p of [...(fb?.parts ?? []), ...(fb?.answers?.parts ?? [])]) {
		if (p.kind === 'unread-work') still_unread.add(p.title);
		for (const w of p.with ?? []) if (is_unread(w)) still_unread.add(w);
	}
	const b_known = !!fb || b_clean;
	const done: { ms: number; wait: boolean; kind: string }[] = [];
	for (const part of fa.parts) {
		if (part.kind === 'unread-work') {
			if (b_known && !still_unread.has(part.title)) done.push(part);
			continue;
		}
		let share = 0;
		for (const t of [part.title, ...(part.with ?? [])]) {
			const d = find(t);
			if (!d) continue;
			// how much of THAT fix is done: all of it (gone), or its share — by its size (what it saves
			// now against then) and by its own sites (gone from the newer report's flagged code is done,
			// whatever the same kind now flags elsewhere: the chains fixed, a new wait between the
			// batches). The larger: the sites miss a fix that shrank a line in place, the size misses one
			// that moved the flag to other calls
			let frac = 0;
			if (d.status === 'fixed') frac = 1;
			else if (d.status === 'better' && d.a_save > 0) {
				const l = left?.get(bare_title(t));
				frac = Math.max(
					Math.min(1, Math.max(0, (d.a_save - d.b_save) / d.a_save)),
					l === undefined ? 0 : 1 - l
				);
			}
			if (frac <= 0) continue;
			// the part's own fix counts as the part; a fix it only COVERS (in its `with`) is worth no more
			// than its own saving — the part's own fix still standing keeps the rest
			share = Math.max(
				share,
				t === part.title || part.ms <= 0 ? frac : Math.min(1, (frac * d.a_save) / part.ms)
			);
		}
		if (share > 0) done.push({ ms: part.ms * share, wait: part.wait, kind: part.kind });
	}
	return fa.now_ms - saving_of(done, fa.caps ?? {}, fa.now_ms).after;
}

/** The patterns a change fixed or shrank, their expected saving summed, against the median render's
 *  measured change. A saving well under the prediction usually moved somewhere (another line got
 *  slower) or drowned in run-to-run noise; well over it, the fix removed more than the pattern saw. */
export function fix_check_of(
	patterns: readonly PatternDelta[],
	a: ReportMeta,
	b: ReportMeta,
	fa?: Forecast,
	fb?: Forecast,
	left?: Map<string, number>
): Comparison['fix_check'] {
	if (a.trigger !== 'page' || b.trigger !== 'page' || !a.runs?.length || !b.runs?.length)
		return undefined;
	const predicted = fa?.parts.length
		? // (a newer page render that came out clean has no forecast: nothing of the old is left)
			promised_by(fa, fb, patterns, left, !fb && (b.run_status ?? 200) === 200)
		: summed_promise(patterns);
	if (predicted < 2) return undefined;
	const measured = median(a.runs) - median(b.runs);
	const verdict =
		measured >= predicted * 0.6 && measured <= predicted * 1.6
			? 'as-expected'
			: measured < predicted * 0.6
				? 'less'
				: 'more';
	return { predicted_ms: round2(predicted), measured_ms: round2(measured), verdict };
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
const median = (xs: number[]) =>
	xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : 0;

function label_of(m: ReportMeta): string {
	if (m.trigger === 'page') return `page ${m.page} ×${m.runs?.length ?? 0}`;
	if (m.trigger === 'request') return `request ${m.request?.path ?? ''}`;
	if (m.trigger === 'trap') return `caught ${m.request?.path ?? ''}`;
	return `${Math.round(m.duration_ms / 1000)}s window`;
}

function delta_rows(
	a: {
		key: string;
		name: string;
		url: string;
		line: number;
		self_ms: number;
		total_ms: number;
		calls?: number;
	}[],
	b: typeof a,
	by: 'key' | 'name'
): DeltaRow[] {
	const map = new Map<string, DeltaRow>();
	for (const f of a) {
		map.set(f[by], {
			key: f[by],
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
				key: f[by],
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
	return [...map.values()].sort(
		(x, y) => Math.abs(y.d_self) - Math.abs(x.d_self) || Math.abs(y.d_total) - Math.abs(x.d_total)
	);
}

export function compare_reports(
	a: {
		meta: ReportMeta;
		analysis: Analysis;
		findings: string[];
		gc?: GcAttribution;
		patterns?: Pattern[];
		ledger?: LedgerLine[];
		drill?: DrillNode;
		forecast?: Forecast;
	},
	b: {
		meta: ReportMeta;
		analysis: Analysis;
		findings: string[];
		gc?: GcAttribution;
		patterns?: Pattern[];
		ledger?: LedgerLine[];
		drill?: DrillNode;
		forecast?: Forecast;
	}
): Comparison {
	const drill = drill_deltas(a.drill, b.drill);
	const order = order_of(a, b);
	const A = a.analysis;
	const B = b.analysis;
	// PER RENDER, both sides: a page profile's CPU, GC, allocations, components, functions and paths
	// add up every render it ran, so a 3-run report against a 10-run one read about 3× "better" with
	// no code changed. Each side is divided by its own runs (the timeline and the waits are one
	// render already; call counts come from the one coverage render).
	const ra = renders_of(a.meta);
	const rb = renders_of(b.meta);
	const per = <T extends { self_ms: number; total_ms: number }>(
		list: readonly T[],
		r: number
	): T[] =>
		r === 1
			? [...list]
			: list.map((f) => ({
					...f,
					self_ms: round2(f.self_ms / r),
					total_ms: round2(f.total_ms / r)
				}));
	// the garbage makers, matched by line (name + the app caller): allocated and GC caused, both sides
	const gc_makers = new Map<string, GcMakerDelta>();
	const mb = (n: number) => round2(n / 1048576);
	for (const m of a.gc?.makers ?? []) {
		const al = mb(m.allocated / ra);
		const g = round2(m.gc_ms / ra);
		gc_makers.set(`${m.name}|${m.caller ?? ''}`, {
			name: m.name,
			caller: m.caller ?? null,
			component: m.component,
			a_mb: al,
			b_mb: 0,
			d_mb: -al,
			a_gc_ms: g,
			b_gc_ms: 0,
			d_gc_ms: -g,
			only: 'a'
		});
	}
	for (const m of b.gc?.makers ?? []) {
		const k = `${m.name}|${m.caller ?? ''}`;
		const r = gc_makers.get(k);
		const al = mb(m.allocated / rb);
		const g = round2(m.gc_ms / rb);
		if (r) {
			r.b_mb = al;
			r.d_mb = round2(r.b_mb - r.a_mb);
			r.b_gc_ms = g;
			r.d_gc_ms = round2(g - r.a_gc_ms);
			delete r.only;
		} else
			gc_makers.set(k, {
				name: m.name,
				caller: m.caller ?? null,
				component: m.component,
				a_mb: 0,
				b_mb: al,
				d_mb: al,
				a_gc_ms: 0,
				b_gc_ms: g,
				d_gc_ms: g,
				only: 'b'
			});
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
		summary.push(
			row('render (median run)', median(a.meta.runs ?? []), median(b.meta.runs ?? []), 'ms')
		);
	} else if (a.meta.trigger === 'request' && b.meta.trigger === 'request') {
		summary.push(row('request', a.meta.request?.ms ?? 0, b.meta.request?.ms ?? 0, 'ms'));
	}
	summary.push(row('CPU busy (per render)', A.busy_ms / ra, B.busy_ms / rb, 'ms'));
	// GC: the observer's pauses with the profiler's share taken out when the attribution ran (the
	// precise number), else the sampler's GC frames — one number, the same one the report shows
	summary.push(
		row(
			'garbage collection (per render)',
			(a.gc?.summary.total_ms ?? A.gc_ms) / ra,
			(b.gc?.summary.total_ms ?? B.gc_ms) / rb,
			'ms'
		)
	);
	if (a.gc || b.gc)
		summary.push(
			row(
				'allocated (per render)',
				(a.gc?.summary.allocated_mb ?? 0) / ra,
				(b.gc?.summary.allocated_mb ?? 0) / rb,
				'MB'
			)
		);
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
	const og = (m: ReportMeta) => own_requests(m).find((r) => r.og)?.og;
	const oa = og(a.meta);
	const ob = og(b.meta);
	if (oa || ob) {
		summary.push(row('ogygia transform', oa?.transform_ms ?? 0, ob?.transform_ms ?? 0, 'ms'));
		summary.push(
			row('page seed', (oa?.seed_bytes ?? 0) / 1024, (ob?.seed_bytes ?? 0) / 1024, 'KB')
		);
		summary.push(
			row('island props', (oa?.tail_bytes ?? 0) / 1024, (ob?.tail_bytes ?? 0) / 1024, 'KB')
		);
	}
	summary.push(row('components seen', A.components.length, B.components.length, 'n'));

	const phase_map = new Map<Phase, { a: number; b: number }>();
	for (const p of A.timeline?.phases ?? [])
		phase_map.set(p.phase, { a: p.cpu_ms + p.wait_ms, b: 0 });
	for (const p of B.timeline?.phases ?? []) {
		const r = phase_map.get(p.phase) ?? { a: 0, b: 0 };
		r.b = p.cpu_ms + p.wait_ms;
		phase_map.set(p.phase, r);
	}
	const phases = [...phase_map.entries()]
		.map(([phase, r]) => ({
			phase,
			label: PHASE_LABEL[phase],
			a: round2(r.a),
			b: round2(r.b),
			d: round2(r.b - r.a)
		}))
		.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));

	// a finding reads `code: message`: its kind is the code
	const code_of = (f: string) => {
		const colon = f.indexOf(':');
		return colon === -1 ? f : f.slice(0, colon);
	};
	const a_codes = new Set(a.findings.map(code_of));
	const b_codes = new Set(b.findings.map(code_of));
	// paths by owner name
	const paths = new Map<string, PathDelta>();
	for (const g of A.paths ?? []) {
		const ms = round2(g.ms / ra);
		paths.set(g.owner.name, {
			owner: g.owner.name,
			file: g.owner.url,
			line: g.owner.line,
			a_ms: ms,
			b_ms: 0,
			d_ms: -ms,
			a_fns: g.fns.map((f) => f.name),
			b_fns: [],
			only: 'a'
		});
	}
	for (const g0 of B.paths ?? []) {
		const g = { ...g0, ms: round2(g0.ms / rb) };
		const row = paths.get(g.owner.name);
		if (row) {
			row.b_ms = g.ms;
			row.d_ms = round2(g.ms - row.a_ms);
			row.b_fns = g.fns.map((f) => f.name);
			row.file = g.owner.url;
			row.line = g.owner.line;
			delete row.only;
		} else
			paths.set(g.owner.name, {
				owner: g.owner.name,
				file: g.owner.url,
				line: g.owner.line,
				a_ms: 0,
				b_ms: g.ms,
				d_ms: g.ms,
				a_fns: [],
				b_fns: g.fns.map((f) => f.name),
				only: 'b'
			});
	}
	const patterns = pattern_deltas(a.patterns, b.patterns, ra, rb);
	const checked = fix_check_of(
		patterns,
		a.meta,
		b.meta,
		a.forecast,
		b.forecast,
		still_there(a.patterns, b.patterns)
	);
	// B ran after A on the heap A filled: B reads slower than its code is, so a fix that "saved less"
	// is most likely the run order, not time that moved
	const fix_check =
		checked && order?.earlier === 'a' ? { ...checked, skewed: true as const } : checked;
	return mark_shifted({
		a: { id: a.meta.id, label: label_of(a.meta), created: a.meta.created },
		b: { id: b.meta.id, label: label_of(b.meta), created: b.meta.created },
		summary,
		phases,
		components: delta_rows(per(A.components, ra), per(B.components, rb), 'name'),
		functions: delta_rows(
			per(A.functions.slice(0, 120), ra),
			per(B.functions.slice(0, 120), rb),
			'key'
		).slice(0, 60),
		findings: {
			// BY KIND (the code before the colon), not the text: a finding's numbers move every run, and
			// by text every finding read as new. A kind only one side has is the change. Each text once
			// (two findings can read the same, and a view keys the list by its text)
			added: [...new Set(b.findings.filter((f) => !a_codes.has(code_of(f))))],
			gone: [...new Set(a.findings.filter((f) => !b_codes.has(code_of(f))))]
		},
		paths: [...paths.values()].sort((x, y) => Math.abs(y.d_ms) - Math.abs(x.d_ms)),
		gc_makers: [...gc_makers.values()]
			.filter((m) => Math.abs(m.d_mb) >= 0.5 || Math.abs(m.d_gc_ms) >= 0.5)
			.sort(
				(x, y) => Math.abs(y.d_gc_ms) - Math.abs(x.d_gc_ms) || Math.abs(y.d_mb) - Math.abs(x.d_mb)
			),
		patterns,
		...(fix_check ? { fix_check } : {}),
		lines: line_deltas(a.ledger, b.ledger, renders_of(a.meta), renders_of(b.meta)),
		...(drill.length ? { drill } : {}),
		...(order ? { order } : {}),
		...render_same_of(a.meta, b.meta)
	});
}

/** Page-mode reports grouped by page, oldest first, with each run's median — the history line. */
export function page_history(
	metas: ReportMeta[],
	/** the page score of a report, when the caller can compute it (the dashboard's trend) */
	score_of?: (id: string) => number | undefined
): { page: string; points: { id: string; created: number; median: number; score?: number }[] }[] {
	const by_page = new Map<string, { id: string; created: number; median: number; score?: number }[]>();
	for (const m of metas) {
		if (m.trigger !== 'page' || !m.page || !m.runs?.length) continue;
		const list = by_page.get(m.page) ?? [];
		const score = score_of?.(m.id);
		list.push({ id: m.id, created: m.created, median: round2(median(m.runs)), ...(score !== undefined ? { score } : {}) });
		by_page.set(m.page, list);
	}
	return [...by_page.entries()]
		.map(([page, points]) => ({ page, points: points.sort((x, y) => x.created - y.created) }))
		.filter((h) => h.points.length >= 1)
		.sort((x, y) => y.points.at(-1)!.created - x.points.at(-1)!.created);
}
