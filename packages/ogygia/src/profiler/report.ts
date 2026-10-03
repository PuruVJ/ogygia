/**
 * Profiler report DATA: the analyzed profile as curated JSON (`report_json`, the agent view), the
 * dump codec that round-trips a report (`report_dump` / `is_dump`), the findings derivation the UI
 * and the JSON both render from, and the request-log types. The HTML rendering moved to the Svelte
 * components in `./ui/` (rendered through `document()`); this file is pure, testable logic.
 */

import type { Analysis, FrameStat, HeapAllocator } from './analyze.js';
import { another_routes_file } from './route-files.js';
import { sequential_ms, type NetCall } from './net.js';
import type { Visit } from './visit.js';
import { browser_findings, browser_page_report } from './browser-findings.js';
import { DOM_LARGE, explain_held_open, lcp_font, lcp_rivals, vital_parts, type HeldOpen } from '../devtools/page-insights.js';
import { compare as fp_compare } from '../devtools/fp-drift.js';
import type { ClientWindows, InteractionCpu } from './client-windows.js';
import type { ByteStrip } from './byte-strip.js';
import { runtime_scripts, type PageAssets, type RuntimeScripts } from './page-assets.js';
import { unscoped_finding } from '../unscoped-css.js';
import type { River } from './river.js';
import type { GcAttribution } from './gc.js';
import { sync_io, memo_candidates, span_values, type Retained } from './insights.js';
import { page_score, fmt_bytes, type ScoreInputs, type ScoreAssets, type PageScore } from './score.js';

/** a file's name from its URL, for a score detail line */
function asset_name(url: string): string {
	const q = url.indexOf('?');
	const path = q === -1 ? url : url.slice(0, q);
	return path.slice(path.lastIndexOf('/') + 1) || path;
}
import type { AllocTimeline } from './alloc.js';
import type { Contention } from './contention.js';
import type { Lineage } from './lineage.js';
import type { LedgerLine } from './ledger.js';
import { unread_rows, type DrillNode } from './drill.js';
import type { HeapGrowth, Pattern } from './patterns.js';
import { render_steps } from './steps.js';
import { own_requests } from './own-requests.js';
export { own_requests };
import { io_kind, type IoOp } from './async-io.js';
import { chain_steps, PHASE_LABEL } from './timeline.js';
import type {
	HoleRequestStats,
	HoleStat,
	IslandStat,
	OgygiaRequestStats
} from '../server/request-stats.js';
import type { SpanRecord } from './span.js';

export type { OgygiaRequestStats, SpanRecord, HoleRequestStats, IslandStat };

/** One span name across a recording: how often, how long, what went wrong, who called it. */
export interface SpanRow {
	name: string;
	count: number;
	total_ms: number;
	/** the wall time the spans of this name covered, overlaps counted once — `total_ms` far above
	 *  it means they ran together (a Promise.all), not one after another */
	wall_ms: number;
	/** SELF: the spans' time minus what their child spans covered — `ds.pass` 249 ms with
	 *  `ds.render.all` 178 and `ds.splice` 69 inside it is 2 ms of its own */
	self_ms: number;
	/** the median span's FAIR SHARE of the wall (`fair_shares`): what one costs when many overlap —
	 *  `p50_ms` is then its start-to-end, mostly waiting on the others */
	share_p50_ms: number;
	/** the most spans of this name open at one instant */
	peak: number;
	p50_ms: number;
	max_ms: number;
	errors: number;
	open: number;
	/** `cache` attribute tallies, when the spans carried one */
	cache?: { hit: number; miss: number; miss_ms: number };
	/** distinct callers, most frequent first (at most 3) */
	callers: string[];
	/** other attribute keys seen (shown, not interpreted) */
	attr_keys: string[];
	/** THE BREAKDOWN by attribute value: for each string attribute with a handful of distinct
	 *  values (`tag`, `key`, `table`…), what each value cost — `ds.render` by tag, `db.query` by
	 *  table. `total_ms` is summed, `wall_ms` counts overlaps once. Values are capped; the rest
	 *  fold into `(N more)`. */
	by: Record<
		string,
		{
			value: string;
			count: number;
			total_ms: number;
			wall_ms: number;
			share_ms: number;
			p50_ms: number;
			max_ms: number;
		}[]
	>;
}

/** The union of intervals' length: what overlapping spans cost in wall time. */
function wall_of(ivs: (readonly [number, number])[]): number {
	const sorted = [...ivs].sort((a, b) => a[0] - b[0]);
	let wall = 0;
	let cur: [number, number] | null = null;
	for (const [a, b] of sorted) {
		if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
		else {
			if (cur) wall += cur[1] - cur[0];
			cur = [a, b];
		}
	}
	if (cur) wall += cur[1] - cur[0];
	return wall;
}

/** FAIR SHARES of overlapping intervals: at every instant the wall is split evenly among the
 *  intervals open then, so the shares add up to exactly the union's length. For 242 renders run
 *  together, one's start-to-end (97 ms) is mostly waiting on the other 241; its share (0.8 ms) is
 *  its part of the 185 ms they cost. Also the peak number open at once. O(n log n): the share of
 *  [a, b] is S(b) − S(a), where S is the running integral of 1 / (number open). */
export function fair_shares(ivs: readonly (readonly [number, number])[]): {
	shares: number[];
	peak: number;
} {
	const ev: [number, number][] = [];
	for (const [a, b] of ivs) {
		ev.push([a, 1]);
		ev.push([b, -1]);
	}
	// ends before starts at one instant: touching intervals do not overlap
	ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const times: number[] = [];
	const integral: number[] = [];
	let open = 0;
	let peak = 0;
	let s = 0;
	let t_prev = ev.length ? ev[0][0] : 0;
	for (const [t, d] of ev) {
		if (open > 0) s += (t - t_prev) / open;
		t_prev = t;
		open += d;
		if (open > peak) peak = open;
		times.push(t);
		integral.push(s);
	}
	// S at time t: the value after the last event at or before t (ends sort first, starts last, so
	// the last entry at an instant holds the integral up to it)
	const at = (t: number): number => {
		let lo = 0;
		let hi = times.length - 1;
		let k = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (times[mid] <= t) ((k = mid), (lo = mid + 1));
			else hi = mid - 1;
		}
		return integral[k] ?? 0;
	};
	return { shares: ivs.map(([a, b]) => Math.max(0, at(b) - at(a))), peak };
}

/** Fold the recording's spans per name. */
export function span_rows(spans: readonly SpanRecord[] | undefined): SpanRow[] {
	if (!spans?.length) return [];
	const by = new Map<string, { list: SpanRecord[]; callers: Map<string, number> }>();
	for (const s of spans) {
		let g = by.get(s.name);
		if (!g) by.set(s.name, (g = { list: [], callers: new Map() }));
		g.list.push(s);
		if (s.caller) g.callers.set(s.caller, (g.callers.get(s.caller) ?? 0) + 1);
	}
	const r2 = (n: number) => Math.round(n * 100) / 100;
	// SELF per span: its duration minus the wall its child spans covered inside it
	const children = new Map<number, SpanRecord[]>();
	for (const s of spans)
		if (s.parent !== undefined)
			(children.get(s.parent) ?? children.set(s.parent, []).get(s.parent)!).push(s);
	const self_of = (s: SpanRecord): number => {
		if (s.open || s.ms < 0) return 0;
		const kids = children.get(s.id);
		if (!kids?.length) return s.ms;
		const end = s.start + s.ms;
		const inside = kids
			.filter((k) => !k.open && k.ms >= 0)
			.map((k) => [Math.max(k.start, s.start), Math.min(k.start + k.ms, end)] as const)
			.filter(([a, b]) => b > a);
		return Math.max(0, s.ms - wall_of(inside));
	};
	return [...by.entries()]
		.map(([name, g]) => {
			const done = g.list
				.filter((s) => !s.open && s.ms >= 0)
				.map((s) => s.ms)
				.sort((a, b) => a - b);
			const hit = g.list.filter((s) => s.attrs?.cache === 'hit').length;
			const miss = g.list.filter((s) => s.attrs?.cache === 'miss');
			const keys = new Set<string>();
			for (const s of g.list)
				for (const k of Object.keys(s.attrs ?? {})) if (k !== 'cache') keys.add(k);
			// the union of the intervals: what these spans cost in wall time
			const finished = g.list.filter((s) => !s.open && s.ms >= 0);
			const wall = wall_of(finished.map((s) => [s.start, s.start + s.ms] as const));
			// each span's fair part of that wall, and how many ran at once at the peak
			const fair = fair_shares(finished.map((s) => [s.start, s.start + s.ms] as const));
			const share = new Map(finished.map((s, i) => [s, fair.shares[i]] as const));
			const share_sorted = [...fair.shares].sort((a, b) => a - b);
			// by attribute value: a string attribute with 2..60 distinct values across the spans
			const by: SpanRow['by'] = {};
			for (const k of keys) {
				const groups = new Map<string, SpanRecord[]>();
				let usable = true;
				for (const s of finished) {
					const v = s.attrs?.[k];
					if (v === undefined) continue;
					if (typeof v !== 'string' && typeof v !== 'boolean') {
						usable = false;
						break;
					}
					const key = String(v);
					(groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
					if (groups.size > 60) {
						usable = false;
						break;
					}
				}
				// a breakdown says something only when values repeat: a key that is unique per span
				// (`stock.lookup` by product id) is the span list again, not a split
				if (!usable || groups.size < 2 || groups.size > g.list.length / 2) continue;
				const rows = [...groups]
					.map(([value, list]) => {
						const sorted = list.map((s) => s.ms).sort((a, b) => a - b);
						return {
							value,
							count: list.length,
							total_ms: r2(sorted.reduce((a, c) => a + c, 0)),
							wall_ms: r2(wall_of(list.map((s) => [s.start, s.start + s.ms] as const))),
							share_ms: r2(list.reduce((a, s) => a + (share.get(s) ?? 0), 0)),
							p50_ms: sorted[Math.floor(sorted.length / 2)] ?? 0,
							max_ms: sorted.at(-1) ?? 0
						};
					})
					.sort((a, b) => b.wall_ms - a.wall_ms || b.total_ms - a.total_ms);
				if (rows.length > 12) {
					const rest = rows.splice(12);
					rows.push({
						value: `(${rest.length} more)`,
						count: rest.reduce((a, r) => a + r.count, 0),
						total_ms: r2(rest.reduce((a, r) => a + r.total_ms, 0)),
						wall_ms: r2(rest.reduce((a, r) => a + r.wall_ms, 0)),
						share_ms: r2(rest.reduce((a, r) => a + r.share_ms, 0)),
						p50_ms: 0,
						max_ms: Math.max(...rest.map((r) => r.max_ms))
					});
				}
				by[k] = rows;
			}
			return {
				name,
				count: g.list.length,
				total_ms: r2(done.reduce((a, c) => a + c, 0)),
				wall_ms: r2(wall),
				self_ms: r2(finished.reduce((a, s) => a + self_of(s), 0)),
				by,
				share_p50_ms: r2(share_sorted[Math.floor(share_sorted.length / 2)] ?? 0),
				peak: fair.peak,
				p50_ms: done[Math.floor(done.length / 2)] ?? 0,
				max_ms: done.at(-1) ?? 0,
				errors: g.list.filter((s) => s.error).length,
				open: g.list.filter((s) => s.open).length,
				...(hit || miss.length
					? {
							cache: {
								hit,
								miss: miss.length,
								miss_ms: r2(miss.reduce((a, s) => a + Math.max(s.ms, 0), 0))
							}
						}
					: {}),
				callers: [...g.callers.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 3)
					.map(([c]) => c),
				attr_keys: [...keys].sort()
			};
		})
		.sort((a, b) => b.total_ms - a.total_ms);
}

export interface RequestEntry {
	ts: number;
	method: string;
	path: string;
	route: string | null;
	status: number;
	ms: number;
	/** CPU ms this request burned (process-wide delta; accurate when requests don't overlap) */
	cpu_ms: number;
	/** how many other requests were in flight when this one started */
	inflight: number;
	/** total ms this request spent in outbound network calls */
	net_ms: number;
	net_count: number;
	/** true when the profiler itself made this request (page mode) */
	internal?: boolean;
	/** what ogygia's handle added to this page (server/request-stats.ts); absent off the page path */
	og?: OgygiaRequestStats;
	/** `tag()` stamps from the app (tenant, locale, variant…) */
	tags?: Record<string, string>;
	/** `span()` counts for this request: how many, and the top-level spans' summed ms */
	span_count?: number;
	span_ms?: number;
	/** a deferred hole's endpoint request: what its render cache did */
	hole?: HoleRequestStats;
	/** performance.now() at the request's start (the trap matches a window's timeline on it) */
	pt?: number;
	/** the request's query string, kept so a caught request can be replayed */
	search?: string;
	/** the headers the trap config asked to keep for a replay */
	replay_headers?: Record<string, string>;
}

/** The page's web vitals as the profiler user's browser reported them (p50 over the visits). */
export interface PageVitals {
	n: number;
	ttfb: number | null;
	fcp: number | null;
	lcp: number | null;
	cls: number | null;
	inp: number | null;
}

/** The cold render (the warm-up) profiled on its own: what module load + compile cost per file. */
export interface ColdStart {
	/** wall ms of the cold render */
	ms: number;
	busy_ms: number;
	/** self ms per file in the cold render, heaviest first */
	files: { file: string; category: import('./analyze.js').FrameCategory; ms: number }[];
	/** the cold render's CPU by owner, grouped as the drill-down's rows are (a package, `node core`,
	 *  a function, a component): what each row cost cold */
	owners?: { label: string; ms: number }[];
	/** outbound calls the cold render made: none means its extra waiting is not new connections */
	calls?: number;
}

/** What the browser reported for one island fingerprint (the runtime's hydration beacon). */
export interface ClientIslandStat {
	/** the island's first fingerprint (the samples of every fingerprint of the entry are merged) */
	fp: string;
	entry: string;
	/** the component's name, when the server row carried it */
	name: string;
	/** hydrations seen */
	n: number;
	/** wake → `data-hydrated`, p50 and max */
	p50_ms: number;
	max_ms: number;
	/** the module-load part of it (hydrate core + the island's chunk closure), p50 */
	load_p50_ms: number;
	/** hydrations that discarded the server DOM and re-rendered: the markup the browser found was
	 *  not the markup the server sent (a post-SSR pass, a script that edited it before wake) */
	recovered: number;
	/** the named first divergence — the WHY of the recovery (e.g. "an injected <style>", "scoped
	 *  web-component hydration marks", "whitespace stripped"). Absent when unnameable. */
	reason?: string;
}

export interface MemSample {
	/** ms offset from window start */
	t: number;
	rss: number;
	heap_used: number;
}

export interface ReportMeta {
	id: string;
	created: number;
	/** `trap`: a slow request the background trap caught (its `request` is the one) */
	trigger: 'window' | 'page' | 'request' | 'trap';
	/** trap mode: the threshold the request crossed */
	trap_over?: number;
	/** page mode: the cold (warm-up) render profiled on its own */
	cold?: ColdStart;
	/** page mode: renders served the answers that were the same in every timed render, from memory
	 *  (`calls` of them): what keeping those answers takes off, measured */
	answers?: { runs_ms: number[]; calls: number };
	/** page mode: the path that was rendered */
	page?: string;
	/** page mode: the originally-requested path, when it redirected to `page` (trailing slash, i18n, …) */
	redirected_from?: string;
	/** page mode: wall ms of the one un-profiled warm-up render (cold module load / cache fill) */
	warmup_ms?: number;
	/** page mode: the HTTP status the profiled renders returned (200 = a real render; 3xx/4xx = not) */
	run_status?: number;
	/** page mode: representative response body size in bytes (a real page is large; a redirect is tiny) */
	run_bytes?: number;
	/** page mode: every render returned the same document, byte for byte */
	same_document?: boolean;
	/** page mode, when the renders' documents differ: what changes between the first and the last */
	doc_diff?: import('./doc-diff.js').DocDiff;
	/** page mode: a plain note when the run plan was trimmed to fit the serverless budget */
	budget_note?: string;
	/** recorded on AWS Lambda (Amplify's SSR), where a request is billed for its whole duration */
	lambda?: boolean;
	/** on Lambda: the function's memory, MB (it bills memory × wall time) */
	lambda_mb?: number;
	/** the V8 heap limit of the instance, MB: how far a leak can grow before the process dies */
	heap_limit_mb?: number;
	/** the instance it ran on: ms from the process start to its first request (a cold start on
	 *  Lambda, where an instance starts for a request), Node's own startup within that, its age and
	 *  the requests it served before this one */
	instance?: { first_request_ms: number; node_ms: number; age_s: number; requests_before: number };
	/** page mode: each render run, ms, AS THE APP WOULD HAVE PAID IT — the profiler's own share (its
	 *  CPU frames, its part of the GC pauses) taken out; `runs_measured` is what the clock said */
	runs?: number[];
	/** page mode: renders another visitor of the same page overlapped — left out of `runs`, their
	 *  samples set aside (at least one render ran clean) */
	runs_set_aside?: number;
	runs_measured?: number[];
	/** the profiler's own cost inside the window, measured once and kept out of every other number */
	overhead?: {
		cpu_ms: number;
		gc_ms: number;
		per_run_ms: number;
		per_run?: number[];
		note: string;
	};
	/** request mode: the profiled request */
	request?: { method: string; path: string; route: string | null; ms: number };
	duration_ms: number;
	sample_interval_us: number;
	/** requests that completed inside the recording window */
	requests: RequestEntry[];
	loop_delay?: { p50: number; p99: number; max: number };
	cpu_percent?: number;
	elu_percent?: number;
	rss_mb?: number;
	node: string;
	/** recorded on the dev server (numbers include Vite's module pipeline) */
	dev?: boolean;
}

export interface UserTiming {
	name: string;
	count: number;
	total_ms: number;
	max_ms: number;
}

export interface GcSummary {
	count: number;
	total_ms: number;
	max_ms: number;
}

export interface ReportExtras {
	net: NetCall[];
	/** the app's own spans (`span()` from ogygia/profiler) recorded during the window */
	spans?: SpanRecord[];
	heap: HeapAllocator[] | null;
	/** bytes per component (the nearest component above each sampled allocation) */
	heap_components?: { name: string; bytes: number }[] | null;
	mem: MemSample[];
	/** performance.measure() spans emitted by the app/libraries during the window */
	measures?: UserTiming[];
	/** precise GC pauses from PerformanceObserver (more exact than the sampler) */
	gc?: GcSummary | null;
	/** I/O primitives timed via async_hooks (timers, fs, dns, sockets) */
	io?: IoOp[];
	/** exact call count per function name, from V8 precise coverage */
	call_counts?: Record<string, number>;
	/** bytes of each island module / preload href (a built app; measured after the recording) */
	weights?: Record<string, number>;
	/** what is inside each hashed chunk: a readable source list from the build's handoff */
	contents?: Record<string, string[]>;
	/** each island file's rendered total and heaviest named modules (the build's handoff) */
	heavy?: Record<string, { total: number; top: { name: string; bytes: number }[] }>;
	/** re-export barrels each island file still holds, with how many modules each brings */
	barrels?: Record<string, { name: string; fanout: number }[]>;
	/** the visit's own hole requests from the request log (made after the recording): server ms each */
	/** `name`: the hole's component, from its own request (a hole the profiled render did not have —
	 *  the visited page's query put it there — is named all the same) */
	hole_requests?: { id: string; ms: number; name?: string; p?: string }[];
	/** the visit's in-app navigations, server side: the page request each one made (by its start `t`,
	 *  the page clock) — its ms, the CPU it burned, its outbound calls */
	nav_requests?: { t: number; ms: number; cpu_ms: number; net_ms: number; net_count: number; inflight?: number }[];
	/** the visit's own document request as the server's handler held it (the request log) */
	doc_request?: { ms: number };
	/** browser-side hydration timings joined by fingerprint (the runtime's beacon) */
	client?: ClientIslandStat[];
	/** the page's web vitals from the same beacon */
	vitals?: PageVitals;
	/** the app's own browser marks (`mark()` from ogygia/profiler/client) for the page, per name */
	client_marks?: ClientMarkStat[];
	/** the browser's CPU profile of the page's hydration (the profiler user's latest visit) */
	/** `windows`: the same trace cut to each island's hydrate window and the long tasks outside them */
	client_cpu?: { analysis: Analysis; at: number; sample_ms: number; windows?: ClientWindows };
	/** the visit's slowest interaction, sampled: what ran while it waited, and in its handlers */
	interaction_cpu?: InteractionCpu;
	/** a caught request's inputs (path + query, the kept headers): the "profile it again" button */
	replay?: { path: string; headers: Record<string, string> };
	/** the browser's picture of a visit to this page (the beacon) — the one-clock timeline joins it */
	visit?: Visit;
	/** the rendered document as a byte strip */
	strip?: ByteStrip;
	/** every file the document loads at start, weighed through the app (page-assets.ts); a dev
	 *  server records why it did not weigh instead */
	assets?: PageAssets;
	assets_missing?: string;
	/** calls → loads → page.data keys → islands */
	river?: River;
	/** who caused the GC: each pause joined to the allocations before it */
	gc_attr?: GcAttribution;
	/** promises created in the window (count, sampled creators) */
	promises?: { count: number; top: { caller: string; share: number }[] };
	/** what one more render left alive after a full collection, by allocation site */
	retained?: Retained;
	/** when the heap grew and what ran then */
	alloc?: AllocTimeline;
	/** the other requests the instance answered while the render ran */
	contention?: Contention;
	/** which component reads which page.data key, from the sources */
	lineage?: Lineage;
	/** the app lines that cost the most, every cost joined per line */
	ledger?: LedgerLine[];
	/** the known slow shapes found on those lines, grouped */
	patterns?: Pattern[];
	/** one render's time as a tree that adds up: phase → owner / call → line (drill.ts) */
	drill?: DrillNode;
	/** one render after every fix named, estimated without counting a saving twice */
	forecast?: import('./forecast.js').Forecast;
	/** a few more renders with a full collection after each: does the heap keep growing? */
	growth?: HeapGrowth;
}

/** One `mark()` name as the profiler user's browser reported it for the page. */
export interface ClientMarkStat {
	name: string;
	n: number;
	p50_ms: number;
	max_ms: number;
	errors: number;
	/** the attribute keys seen on it */
	attr_keys: string[];
}

export interface RouteAgg {
	route: string;
	count: number;
	p50: number;
	p95: number;
	max: number;
	avg: number;
	net_p50: number;
}

const fmt_ms = (n: number): string =>
	n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
const fmt_pct = (part: number, whole: number): string =>
	whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '—';
const round1 = (n: number): number => Math.round(n * 10) / 10;
/** The dev server's own packages: their work (module loading, transforms) exists only in dev. */
const DEV_TOOLS = new Set(['vite', 'rolldown', 'rollup', 'esbuild', 'vite-node', 'vitefu', 'postcss', 'lightningcss', '@sveltejs/vite-plugin-svelte']);
/** A sampled origin that is a dev tool's: `fn (vite)` — a package in the brackets, not a `file:line`. */
export function dev_tool_caller(caller: string): boolean {
	const open = caller.lastIndexOf('(');
	if (open === -1 || !caller.endsWith(')')) return false;
	const pkg = caller.slice(open + 1, -1);
	return DEV_TOOLS.has(pkg) || pkg.startsWith('@rolldown/') || pkg.startsWith('@vitejs/');
}
const CALL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'await', 'function', 'catch', 'typeof', 'new', 'yield']);
/**
 * Where inside a hot function its time lands, when one line holds the biggest share and it is not
 * the function's own first line: that line, its code, and the function it calls there. Once V8
 * inlines a callee its time is the caller's own — a load "burning" 85 ms is often one call in it
 * (measured on /inferno: newestReview inlined into load, named in one run of six). No regex.
 */
export function hot_line_of(f: Pick<FrameStat, 'name' | 'line' | 'self_ms' | 'lines' | 'src'>, app_fns: ReadonlySet<string>): { line: number; ms: number; code: string; calls?: string } | null {
	const top = f.lines?.[0];
	if (!top || top.line === f.line || top.ms < f.self_ms * 0.4 || !f.src) return null;
	const text = f.src.lines[top.line - f.src.start];
	if (text === undefined) return null;
	const code = text.trim();
	if (!code) return null;
	// the first call on the line to one of the app's own functions (the identifier right before a `(`):
	// what V8 may have inlined — a builtin (`Math.max`, `new Date`) is the line's own work
	let calls: string | undefined;
	let start = -1;
	for (let i = 0; i < code.length; i++) {
		const c = code.charCodeAt(i);
		const ident = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
		if (ident) {
			if (start === -1) start = i;
			continue;
		}
		if (c === 40 && start !== -1) {
			const name = code.slice(start, i);
			// (an app function the profile names; or a plain call — not a method, not a constructor:
			// a function inlined everywhere leaves no frame of its own to be named by)
			const plain = (start === 0 || code.charCodeAt(start - 1) !== 46) && name.charCodeAt(0) >= 97 && name.charCodeAt(0) <= 122;
			if (!CALL_KEYWORDS.has(name) && name !== f.name && (app_fns.has(name) || plain)) {
				calls = name;
				break;
			}
		}
		start = -1;
	}
	return { line: top.line, ms: top.ms, code: code.length > 100 ? code.slice(0, 99) + '…' : code, ...(calls ? { calls } : {}) };
}
/** A render that mostly waited: on its timeline, waiting (calls, and what no hook saw) is 60% of a
 *  render of 20 ms or more; with no timeline, the window's CPU under a quarter (the old reading). */
export function mostly_waited(tl: { window_ms: number; wait_ms: number; gap_ms: number } | null | undefined, busy_pct: number): boolean {
	if (!tl) return busy_pct < 25;
	return tl.window_ms >= 20 && tl.wait_ms + tl.gap_ms >= tl.window_ms * 0.6;
}
/** "most of it" only when it is (over half); the biggest of several smaller parts otherwise */
const share_word = (part: number, whole: number): string =>
	whole > 0 && part > whole * 0.5 ? 'most of it' : 'the biggest part';
/** Three significant figures — for costs that can be nanoseconds (a getter called five million
 *  times) where a fixed decimal rounds the whole signal to zero. */
const sig3 = (n: number): number => (n === 0 || !Number.isFinite(n) ? 0 : Number(n.toPrecision(3)));
/** ms per call: `null` when the call count is unknown (an anonymous function coverage cannot
 *  count) — dividing by one there would report the whole total as the cost of a single call. */
const per_call = (total_ms: number, calls: number | null): number | null =>
	calls ? sig3(total_ms / calls) : null;

// ---------------------------------------------------------------------------
// findings + machine-readable JSON (the agent view + the derivation the UI shares)

export interface Finding {
	severity: 'info' | 'warn';
	/** stable machine code, e.g. 'sequential-network' */
	code: string;
	/** one plain-text sentence */
	message: string;
	/** what to do about it, one sentence (a warn usually has one) */
	fix?: string;
	/** the report row it points at: `comp:<name>` / `fn:<key>` — the UI opens that row */
	anchor?: string;
	/** where in the code, when the finding is about one place */
	file?: string;
	line?: number;
	/** the slow pattern (its index in the report's `patterns`) that explains this same problem */
	pattern?: number;
	/** the islands a browser finding is about, by fingerprint (the devtools light them up) */
	fps?: string[];
}

const fmt_kb = (bytes: number) =>
	bytes < 1024 && bytes > 0 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
/** page mode renders the page N times; per-render figures divide by it */
const runs_of = (meta: ReportMeta) =>
	meta.trigger === 'page' ? Math.max(meta.runs?.length ?? 1, 1) : 1;

/** A URL path with its variable segments (numbers, uuids, hashes, long tokens) folded to `:id`. */
export function path_template(url: string): { host: string; tpl: string } {
	try {
		const u = new URL(url);
		const tpl = u.pathname
			.split('/')
			.map((seg) =>
				/^\d+$/.test(seg) ||
				/^[A-Za-z]{0,4}[-_]?\d+$/.test(seg) || // P0, SKU-1000, id_42
				/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) ||
				/^[0-9a-f]{16,}$/i.test(seg) ||
				(seg.length > 20 && /\d/.test(seg))
					? ':id'
					: seg
			)
			.join('/');
		return { host: u.host, tpl };
	} catch {
		return { host: '', tpl: url };
	}
}

/** N+1 shapes: the same endpoint hit once per item. */
export function n_plus_one(
	net: NetCall[],
	min = 5
): { host: string; tpl: string; count: number; ms: number }[] {
	const groups = new Map<string, { host: string; tpl: string; count: number; ms: number }>();
	for (const c of net) {
		if (c.ms < 0) continue;
		const { host, tpl } = path_template(c.url);
		if (!tpl.includes(':id') && !c.url.includes('?')) continue; // a fixed url repeated is caching, not N+1
		const key = c.method + ' ' + host + tpl;
		const g = groups.get(key) ?? { host, tpl, count: 0, ms: 0 };
		g.count++;
		g.ms += c.ms + (c.body_ms ?? 0);
		groups.set(key, g);
	}
	return [...groups.values()]
		.filter((g) => g.count >= min)
		.sort((a, b) => b.count - a.count)
		.map((g) => ({ ...g, ms: Math.round(g.ms * 100) / 100 }));
}

/** The plain-language bottleneck read, as structured data. The HTML verdict and
 * the JSON report both render from this, so they never drift. */
/** THE PAGE'S WEIGHT, as findings: the JS it runs at start (and what the biggest files hold), what
 *  blocks the first paint, the code kept for later. From page-assets.ts — the score reads the same. */
/** The page's own origin, from its weighed files: its islands' (always same-origin), else its first
 *  script's. '' when nothing was weighed. */
export function page_origin(pa: PageAssets | undefined): string {
	if (!pa) return '';
	for (const via of ['island', 'script', 'modulepreload'])
		for (const a of pa.assets)
			if (a.via === via)
				try {
					return new URL(a.url).origin;
				} catch {
					// not a URL
				}
	return '';
}

/** Main-thread ms per host from the browser CPU analysis (functions by their script URL). */
function cpu_by_host(extras: ReportExtras): Map<string, number> | null {
	const a = extras.client_cpu?.analysis;
	if (!a) return null;
	const m = new Map<string, number>();
	for (const f of a.functions) {
		if (!f.path.startsWith('http')) continue;
		let host = '';
		try {
			host = new URL(f.path).host;
		} catch {
			continue;
		}
		m.set(host, (m.get(host) ?? 0) + f.self_ms);
	}
	return m;
}

/**
 * THE PAGE'S JS AT START, as the score and the findings both read it: the files weighed from the
 * HTML and their imports, plus the scripts the profiler user's own browser loaded at runtime that
 * nothing in the HTML names (runtime_scripts — a CDN library fetching its parts, a runtime's
 * on-demand chunk). Without the second half, a page that loads its JS from a script weighed light.
 */
export function start_js(extras: Pick<ReportExtras, 'assets' | 'visit'>): { js: number; js_wire: number; js_files: number; runtime: RuntimeScripts | null; woke_early: { bytes: number; wire: number; files: number } | null } | null {
	const pa = extras.assets;
	if (!pa) return null;
	let runtime: RuntimeScripts | null = null;
	let woke_early: { bytes: number; wire: number; files: number } | null = null;
	const v = extras.visit;
	if (v?.resources.length) {
		const until = (v.nav.load ?? v.nav.res_end) + 3000;
		// "loads later" code the browser loaded at start anyway: an island that wakes when visible,
		// on the first screen of the visit (the weighing cannot know the screen; the visit can). Only
		// what started BEFORE the load event: a visitor who scrolls right after load wakes the islands
		// below the fold within seconds, and that is not the page's start (the score's twins caught
		// a 3 s window counting a scrolled-to editor as start-up JS)
		const loaded_by = v.nav.load ?? v.nav.dcl ?? v.nav.res_end;
		const at_start = new Set(v.resources.filter((r) => r.type === 'script' && r.start <= loaded_by).map((r) => r.url));
		for (const a of pa.assets)
			if (a.lazy && a.kind === 'script' && at_start.has(a.url)) {
				woke_early ??= { bytes: 0, wire: 0, files: 0 };
				woke_early.bytes += a.bytes;
				woke_early.wire += a.wire;
				woke_early.files++;
			}
		// "at start": up to 3 s after the load event (a lazy island a scroll woke later is not)
		runtime = runtime_scripts(pa.assets, v.resources, page_origin(pa), until);
	}
	const t = pa.totals;
	return {
		js: t.js + (runtime?.bytes ?? 0) + (woke_early?.bytes ?? 0),
		js_wire: t.js_wire + (runtime?.wire ?? 0) + (woke_early?.wire ?? 0),
		js_files: t.js_files + (runtime?.files ?? 0) + (woke_early?.files ?? 0),
		runtime,
		woke_early
	};
}

function page_weight_findings(
	meta: ReportMeta,
	extras: ReportExtras,
	info: (code: string, message: string, extra?: Partial<Finding>) => void,
	warn: (code: string, message: string, extra?: Partial<Finding>) => void
): void {
	const pa = extras.assets;
	if (!pa) {
		if (extras.assets_missing) info('page-unweighed', `The page's files were not weighed: ${extras.assets_missing}.`);
		return;
	}
	const t = { ...pa.totals, ...start_js(extras)! };
	const islands = island_rows_of(meta).length;
	const big = pa.assets.filter((x) => x.kind === 'script' && !x.lazy).slice(0, 3);
	const named = big.map((x) => `${asset_name(x.url)} ${fmt_bytes(x.bytes)}${x.contains?.length ? ` (${x.contains.slice(0, 4).join(', ')})` : ''}`);
	// SCRIPTS LOADED AT RUNTIME: invisible in the HTML, measured by the browser
	if (t.runtime && t.runtime.bytes >= 10 * 1024)
		(t.runtime.bytes >= 50 * 1024 ? warn : info)(
			'runtime-scripts',
			`Your browser also loaded ${fmt_bytes(t.runtime.bytes)} of JS in ${t.runtime.files} file${t.runtime.files === 1 ? '' : 's'} that the page's HTML and its imports never name: other scripts fetched ${t.runtime.files === 1 ? 'it' : 'them'} at runtime — ${t.runtime.by.slice(0, 3).map((b) => `${b.who} ${fmt_bytes(b.bytes)} (${b.files})`).join(', ')}. They count in the page's JS.`,
			{ fix: 'A library that loads its own parts (a component CDN, a tag manager) costs more than its first file: load it where it is used, or self-host the parts it needs.' }
		);
	if (t.js >= 150 * 1024) {
		const say = t.js >= 300 * 1024 ? warn : info;
		say(
			'js-at-start',
			`The browser runs ${fmt_bytes(t.js)} of JS in ${t.js_files} files to start this page (${fmt_bytes(t.js_wire)} on the wire${t.runtime ? `, ${fmt_bytes(t.runtime.bytes)} of it loaded at runtime by other scripts` : ''}${t.woke_early ? `, ${fmt_bytes(t.woke_early.bytes)} of it islands that wake when visible and were on your first screen` : ''})${t.lazy_js - (t.woke_early?.bytes ?? 0) > 0 ? `, and ${fmt_bytes(t.lazy_js - (t.woke_early?.bytes ?? 0))} more loads only when an island needs it` : ''}. The biggest: ${named.join('; ')}.`,
			{
				fix: islands
					? 'Wake the heaviest islands when visible or on interaction, move heavy imports server-side, or make static subtrees lakes.'
					: 'This page hydrates as a whole (no islands): render it csr=false and make only its interactive parts islands, so their code loads when they need it.'
			}
		);
	} else if (t.lazy_js >= 50 * 1024)
		info('js-lazy', `${fmt_bytes(t.lazy_js)} of island JS waits until it is needed: the page starts with ${fmt_bytes(t.js)}.`);
	if (t.blocking_count >= 3 || t.blocking >= 100 * 1024) {
		const files = pa.assets.filter((x) => x.blocking).slice(0, 4).map((x) => `${asset_name(x.url)} ${fmt_bytes(x.bytes)}`);
		warn('render-blocking', `${t.blocking_count} files (${fmt_bytes(t.blocking)}) must arrive before anything paints: ${files.join(', ')}.`, {
			fix: 'Inline the small stylesheets, merge the rest, load scripts as modules or with defer.'
		});
	}
	// a component's styles shipped without their scope (the build's fallback marker in the CSS)
	if (pa.unscoped?.length) {
		const f = unscoped_finding(pa.unscoped);
		warn(f.code, f.message, { fix: f.fix });
	}
	if (pa.missed.length) info('assets-missed', `${pa.missed.length} file(s) the page loads could not be weighed (a 404, a timeout, or the time budget): ${pa.missed.slice(0, 3).map(asset_name).join(', ')}.`);
}

export function derive_findings(a: Analysis, meta: ReportMeta, extras: ReportExtras): Finding[] {
	const out: Finding[] = [];
	type Extra = Pick<Finding, 'fix' | 'anchor' | 'file' | 'line'>;
	const info = (code: string, message: string, extra: Extra = {}) =>
		out.push({ severity: 'info', code, message, ...extra });
	const warn = (code: string, message: string, extra: Extra = {}) =>
		out.push({ severity: 'warn', code, message, ...extra });
	// PER RENDER: the analysis adds up every profiled render (page mode); a finding quoting its CPU,
	// GC or allocation says one render's worth, the unit the render time and the line list use.
	// Shares of busy time are ratios and need no division.
	const R = runs_of(meta);
	const pr = (ms: number) => ms / R;
	const per_r = R > 1 ? ' per render' : '';

	const busy_pct = a.duration_ms > 0 ? (a.busy_ms / a.duration_ms) * 100 : 0;
	const net = extras.net.filter((c) => c.ms >= 0);
	const net_total = net.reduce((s, c) => s + c.ms + (c.body_ms ?? 0), 0);
	const seq = sequential_ms(extras.net);
	const net_errors = extras.net.filter((c) => c.error).length;
	const tl = a.timeline;

	info(
		'summary',
		`Over ${fmt_ms(meta.duration_ms)} ms the CPU was busy ${busy_pct.toFixed(0)}%` +
			(net.length
				? ` and ${net.length} outbound network calls took ${fmt_ms(net_total)} ms combined.`
				: '.')
	);

	// Page mode: did we actually profile a real render? A 3xx/4xx status or a tiny body means we
	// measured a redirect or error page, not the page — the classic "3 ms window, no components" report.
	if (meta.trigger === 'page') {
		if (meta.redirected_from && meta.page) {
			info(
				'redirected',
				`Profiled ${meta.page} — followed a redirect from ${meta.redirected_from}.`
			);
		}
		const status = meta.run_status ?? 200;
		const bytes = meta.run_bytes ?? 0;
		if (status >= 300) {
			warn(
				'not-a-render',
				`The profiled renders returned HTTP ${status}, not a page. This is almost always an ` +
					`unfollowed redirect or an error route — the numbers below are not your page. Check the path.`
			);
		} else if (bytes > 0 && bytes < 512) {
			warn(
				'not-a-render',
				`Each render returned only ${bytes} bytes — too small to be the real page (an error, an empty ` +
					`shell, or a cached stub). The profile below is not representative.`
			);
		} else if (a.components.length === 0 && a.sample_count < 200) {
			// no component work AND barely any samples: the page answered 200 with a real body (the
			// branches above took the rest), so it is FAST — a note that says so, not a warning: it read
			// as a warning on 25 of the playground's pages that simply render in a millisecond
			const runs = [...(meta.runs ?? [])].sort((x, y) => x - y);
			const ms = runs.length ? runs[runs.length >> 1] : undefined;
			info(
				'low-confidence',
				`${ms !== undefined ? `This page renders in about ${fmt_ms(ms)} ms: o` : 'O'}nly ${a.sample_count} CPU sample${a.sample_count === 1 ? '' : 's'} and no component took measurable time — there is little here to make faster, and too little for the numbers below to be exact. ` +
					`(Expected a heavier page? A cached or prerendered answer looks like this too: check the URL.)`
			);
		}
		if (meta.warmup_ms !== undefined && meta.runs?.length) {
			const median = [...meta.runs].sort((x, y) => x - y)[Math.floor(meta.runs.length / 2)];
			// warm-up an order of magnitude slower than the steady runs = the app cached the page after
			// the first render (or paid a big cold cost). The warm-up is then the only real render.
			if (median > 0 && meta.warmup_ms > median * 8 && meta.warmup_ms > 200) {
				info(
					'cached-after-first',
					`The first (warm-up) render took ${fmt_ms(meta.warmup_ms)} ms but the timed runs averaged ` +
						`~${fmt_ms(median)} ms — the app appears to cache this page after the first render, so the ` +
						`profile reflects cache hits, not the ${fmt_ms(meta.warmup_ms)} ms first paint.`
				);
			}
		}
		if (meta.budget_note) info('budget', meta.budget_note);
	}

	// THE TIMELINE (one request's critical path): phases, awaits in a row, waits the hooks can't see.
	if (tl) {
		const parts = tl.phases
			.filter((p) => p.cpu_ms + p.wait_ms >= tl.window_ms * 0.03)
			.map(
				(p) =>
					`${PHASE_LABEL[p.phase]} ${fmt_ms(p.cpu_ms)} ms` +
					(p.wait_ms >= 0.5 ? ` + ${fmt_ms(p.wait_ms)} ms waiting` : '') +
					// whose CPU a big part was: "hooks 259 ms (processDsTags 150 ms, render2 (@acme/ui) 80 ms)"
					(p.top?.length && p.cpu_ms >= tl.window_ms * 0.1
						? ` (${p.top
								.slice(0, 2)
								.map((o) => `${o.label} ${fmt_ms(o.ms)} ms`)
								.join(', ')})`
						: '')
			);
		if (parts.length) {
			info(
				'phases',
				`Of the ${fmt_ms(tl.window_ms)} ms render: ${parts.join(' · ')}` +
					(tl.gap_ms >= tl.window_ms * 0.05 ? ` · ${fmt_ms(tl.gap_ms)} ms unaccounted` : '') +
					'.'
			);
		}
		// BILLED WAITING: a Lambda request is billed for its whole duration, so time spent waiting
		// costs what CPU costs; on a server, waiting is nearly free
		if (meta.lambda && tl.wait_ms >= tl.window_ms * 0.3 && tl.wait_ms >= 50) {
			info(
				'billed-wait',
				`On AWS Lambda a request is billed for its whole duration: ${fmt_ms(tl.window_ms)} ms here, and ${fmt_ms(tl.wait_ms)} ms of it (${fmt_pct(tl.wait_ms, tl.window_ms)}) is waiting on calls, not computing. Every millisecond of waiting cut is billed time cut, the same as CPU.`,
				{
					fix: 'Start independent calls together, cache what repeats across requests, and fetch less per render: the wait patterns above name the lines.'
				}
			);
		}
		const group = [...tl.parallelizable].sort((x, y) => y.save_ms - x.save_ms)[0];
		if (group && group.save_ms >= Math.max(5, tl.window_ms * 0.05)) {
			warn(
				'sequential-awaits',
				`${group.calls.length} calls ran one after another for ${fmt_ms(group.ms)} ms: ${group.calls.join(', ')}. ` +
					`Started together they would cost ${fmt_ms(group.ms - group.save_ms)} ms — about ${fmt_ms(group.save_ms)} ms saved.`,
				{
					fix: 'Start them together (Promise.all) when they are independent; a call that needs an earlier result stays sequential.'
				}
			);
		}
		if (tl.gap_ms > tl.window_ms * 0.3 && tl.gap_ms > 20) {
			warn(
				'unseen-wait',
				`${fmt_ms(tl.gap_ms)} ms (${fmt_pct(tl.gap_ms, tl.window_ms)}) of the render waited on something the recorder cannot see — a database driver over its own socket pool, a worker, a queue.`,
				{
					fix: 'Wrap that client in performance.measure() spans; they show under User timings and on the timeline next time.'
				}
			);
		}
	}
	// N+1: the same endpoint once per item.
	for (const g of n_plus_one(net).slice(0, 2)) {
		warn(
			'n-plus-one',
			`${g.count} calls to ${g.host}${g.tpl} — one per item, ${fmt_ms(g.ms)} ms together.`,
			{
				fix: 'Batch them: one request with the ids (or a bulk endpoint), or fetch the list with its children included.'
			}
		);
	}

	// A WINDOW'S REQUESTS: the slowest ones and where their time went — the question a window over a
	// test's actions answers first (which of the requests my clicks made was slow, and was it the
	// server computing or waiting on something)
	if (meta.trigger === 'window') {
		const reqs = meta.requests.filter((r) => !r.internal && r.ms >= 0);
		if (reqs.length) {
			const slow = [...reqs].sort((x, y) => y.ms - x.ms).slice(0, 3);
			const split = (r: RequestEntry) => {
				const wait = Math.max(0, r.ms - r.cpu_ms);
				return `${r.method} ${r.path.split('?')[0]} ${fmt_ms(r.ms)} ms (${fmt_ms(r.cpu_ms)} ms CPU, ${fmt_ms(wait)} ms waiting${r.net_count ? `, ${fmt_ms(r.net_ms)} ms of it on ${r.net_count} outbound call${r.net_count === 1 ? '' : 's'}` : ''})`;
			};
			const overlapped = reqs.some((r) => r.inflight > 0);
			(slow[0].ms >= 1000 ? warn : info)(
				'window-requests',
				`${reqs.length} request${reqs.length === 1 ? '' : 's'} in the window; the slowest: ${slow.map(split).join(' · ')}.` +
					(overlapped ? ' Some ran at the same time: their CPU is the process’s over each one, so it overlaps.' : ''),
				{
					...(slow[0].ms >= 1000
						? {
								fix:
									slow[0].cpu_ms >= slow[0].ms * 0.5
										? 'It is computing: profile that page on its own (page mode) for the lines.'
										: 'It is waiting: the network table and the upstream split say on what.'
							}
						: {})
				}
			);
		}
	}
	// (not over a window: its calls come from many requests, one after another is the test's pace,
	// not an await chain in one request's code — and a window cannot tie a call to its request)
	if (
		meta.trigger !== 'window' &&
		!tl?.parallelizable.length &&
		net.length >= 2 &&
		seq > meta.duration_ms * 0.5 &&
		busy_pct < 60
	) {
		warn(
			'sequential-network',
			`Network calls ran back-to-back for ${fmt_ms(seq)} ms of the window — usually sequential awaits.`,
			{ fix: 'Start independent calls together with Promise.all.' }
		);
	} else if (meta.trigger !== 'window' && (meta.run_status ?? 200) < 300 && mostly_waited(tl, busy_pct) && (net.length || !tl || tl.wait_ms >= tl.gap_ms)) {
		// (read off ONE render's timeline, not the window: between the profiler's renders the process
		// idles, and a page rendering in 0.4 ms read as "mostly waiting … likely a database" — so did a
		// 404. A wait mostly no hook saw is the timeline's own finding, unseen-wait)
		const part = tl ? `: ${fmt_ms(tl.wait_ms + tl.gap_ms)} of the ${fmt_ms(tl.window_ms)} ms render` : '';
		info(
			'mostly-waiting',
			net.length
				? `Mostly waiting on the network, not computing${part}.`
				: `Mostly waiting, not computing${part}, and on no HTTP call: a timer, a file, or a database/socket client (the waiting table names it).`
		);
	}

	const th = top_hosts(net)[0];
	if (th && th.total > meta.duration_ms * 0.2) {
		info(
			'slow-upstream',
			`Slowest upstream: ${th.host || '(unknown)'} — ${th.count} calls, ${fmt_ms(th.total)} ms.`
		);
	}
	if (net_errors)
		warn('network-errors', `${net_errors} network call${net_errors > 1 ? 's' : ''} failed.`);

	const tb = a.buckets.find((b) => b.category !== 'idle' && b.category !== 'profiler');
	if (tb) {
		info(
			'top-cpu',
			`Biggest CPU consumer: ${tb.key} (${fmt_ms(pr(tb.self_ms))} ms${per_r}, ${fmt_pct(tb.self_ms, a.busy_ms)} of busy time).`
		);
	}
	// COMPONENTS: repetition vs one heavy render — each names the row and the fix.
	const by_total = [...a.components].sort((x, y) => y.total_ms - x.total_ms);
	// the route roots (_page / _layout / Root) always carry the biggest total — the whole page is
	// inside them; a real component is the finding whenever one carries the weight
	const is_root = (n: string) => /^_(?:page|layout|error)$|^Root$/.test(n);
	const heavy =
		by_total.find((c) => !is_root(c.name) && c.total_ms >= a.busy_ms * 0.2 && c.total_ms >= 5) ??
		by_total.find((c) => c.total_ms >= a.busy_ms * 0.2 && c.total_ms >= 5);
	if (heavy) {
		const n = heavy.calls ?? 0;
		// its time adds up every render; its count is one render's: both per render here
		const heavy_ms = heavy.total_ms / runs_of(meta);
		const at = { anchor: `comp:${heavy.name}`, file: heavy.url, line: heavy.line };
		if (n >= 20) {
			warn(
				'component-repeat',
				`${heavy.name} rendered ${n} times per render — ${fmt_ms(heavy_ms)} ms, ${fmt_pct(heavy.total_ms, a.busy_ms)} of busy, ${fmt_ms(heavy_ms / n)} ms each.`,
				{
					...at,
					fix: 'Render fewer: paginate or window the list, or move it below the fold into a deferred hole so the page ships without it.'
				}
			);
		} else if (heavy_ms / Math.max(n, 1) >= 20) {
			// what inside it burns: the hot function whose heaviest stack passes through this component
			const inside = a.functions.find(
				(f) =>
					f.key !== heavy.key &&
					f.self_ms >= heavy.total_ms * 0.2 &&
					f.stacks?.[0]?.frames.some((fr) => fr.n === heavy.name)
			);
			warn(
				'component-heavy',
				`One render of ${heavy.name} costs ${fmt_ms(heavy_ms / Math.max(n, 1))} ms (${fmt_pct(heavy.total_ms, a.busy_ms)} of busy)` +
					(inside
						? ` — ${share_word(inside.self_ms, heavy.total_ms)} is ${inside.name} (${inside.url}:${inside.line}), ${fmt_ms(inside.self_ms / runs_of(meta))} ms.`
						: '.'),
				{
					...at,
					fix: 'Compute the expensive part once (in load, or a per-request cache) and pass the result as a prop, or render it in a deferred hole.'
				}
			);
		} else {
			info(
				'top-component',
				`Most expensive component: ${heavy.name} at ${fmt_ms(heavy_ms)} ms ${meta.trigger === 'window' ? 'across the window' : 'per render'}.`,
				at
			);
		}
	} else if (by_total[0]) {
		const tc = by_total[0];
		info(
			'top-component',
			`Most expensive component: ${tc.name} at ${fmt_ms(tc.total_ms / runs_of(meta))} ms ${meta.trigger === 'window' ? 'across the window' : 'per render'}.`,
			{
				anchor: `comp:${tc.name}`,
				file: tc.url,
				line: tc.line
			}
		);
	}
	// HOT FUNCTION: one function (yours or a dependency's) burning a fifth of the CPU — or, when
	// several share the top about evenly, the three together. (A page with three hogs at ~20% each had
	// whichever crossed 20% this run named, and none in some runs: the finding came and went between
	// two profiles of the same code. Named together, the crowd is there every run.)
	const own = a.functions.filter((f) => f.category === 'app' || f.category === 'dependency');
	const hot = own[0];
	const top3 = own.slice(0, 3).filter((f) => f.self_ms >= 5);
	const top3_ms = top3.reduce((s, f) => s + f.self_ms, 0);
	const single = !!hot && hot.self_ms >= a.busy_ms * 0.2;
	const crowd = !!hot && !single && top3.length === 3 && hot.self_ms >= a.busy_ms * 0.12 && top3_ms >= a.busy_ms * 0.4;
	const where = (f: (typeof own)[number]) => (f.label ? `the function at ${f.url}:${f.line}` : `${f.name} (${f.url}:${f.line})`);
	if (hot && hot.self_ms >= 5 && (single || crowd)) {
		const from = hot.stacks?.[0]?.frames.find((fr) => fr.c === 'component' || fr.c === 'app');
		const spot = hot_line_of(hot, new Set(a.functions.filter((f) => f.category === 'app').map((f) => f.name)));
		// (close behind the top one: within a quarter of it — the next profile may rank them the other way)
		const close = own.slice(1, 3).filter((f) => f.self_ms >= 5 && f.self_ms >= hot.self_ms * 0.75);
		const spot_lead = crowd ? `In ${hot.name}, the biggest part` : spot && share_word(spot.ms, hot.self_ms) === 'most of it' ? 'Most of it' : 'The biggest part';
		warn(
			'hot-function',
			(crowd
				? `No one function dominates, but three together burn ${fmt_ms(pr(top3_ms))} ms${per_r} (${fmt_pct(top3_ms, a.busy_ms)} of busy): ${top3.map((f) => `${where(f)} ${fmt_pct(f.self_ms, a.busy_ms)}`).join(', ')}.`
				: `${hot.label ? `The function at ${hot.url}:${hot.line} (\`${hot.label}\`)` : hot.name} burns ${fmt_ms(pr(hot.self_ms))} ms${per_r} (${fmt_pct(hot.self_ms, a.busy_ms)} of busy)${hot.label ? '' : ` at ${hot.url}:${hot.line}`}` +
					(hot.calls ? `, ${hot.calls} calls per render` : '') +
					(from ? `, called from ${from.n}` : '') +
					'.' +
					(close.length ? ` Close behind: ${close.map((f) => `${where(f)} ${fmt_pct(f.self_ms, a.busy_ms)}`).join(', ')}.` : '')) +
				(spot
					? ` ${spot_lead} lands on line ${spot.line}: \`${spot.code}\`` +
						(spot.calls ? ` — ${spot.calls} is called there, and V8 counts a function it inlined as the caller's own time: look inside ${spot.calls}.` : '.')
					: ''),
			{
				anchor: `fn:${hot.key}`,
				file: hot.url,
				line: spot?.line ?? hot.line,
				fix:
					hot.category === 'dependency'
						? `It is ${hot.pkg}'s — cache or batch what you ask of it per request, and check the call count against what the page really needs.`
						: 'Hoist per-request work out of per-row code, precompute it in load, or cache the result across requests.'
			}
		);
	}
	// SERIALIZATION: devalue / JSON of load data and island props.
	const ser = a.functions.filter(
		(f) => f.pkg === 'devalue' || (f.name === 'stringify' && f.category === 'dependency')
	);
	// (Kit's own copy of the server load data is its own finding — kit-uneval — not counted twice here)
	const ser_ms = Math.max(0, ser.reduce((s, f) => s + f.self_ms, 0) - kit_load_serialize_ms(a));
	if (ser_ms >= a.busy_ms * 0.1 && ser_ms >= 5) {
		warn(
			'serialization',
			`Serializing data took ${fmt_ms(pr(ser_ms))} ms${per_r} (${fmt_pct(ser_ms, a.busy_ms)} of busy) — the page's load data and island props on their way to the browser.`,
			{
				anchor: ser[0] ? `fn:${ser[0].key}` : undefined,
				fix: 'Ship less: return from load only what the page reads, keep big blobs out of page.data, and let islands take props rather than reading $page whole.'
			}
		);
	}
	// SPANS: what the app named itself. Per name across the window (page mode: N renders, so the
	// per-render count is `count / runs`).
	const runs = meta.trigger === 'page' ? Math.max(meta.runs?.length ?? 1, 1) : 1;
	const spans = span_rows(extras.spans);
	// one render's worth of window: page mode's window spans every run
	const window_ms = tl?.window_ms ?? meta.duration_ms / runs;
	// a window holds many requests (a test's actions): "in one render" would be a claim it cannot make
	const in_one = meta.trigger === 'window' ? 'during the window' : 'in one render';
	for (const s of spans) {
		const per_render = s.count / runs;
		const ms_per_render = s.total_ms / runs;
		const site = s.callers[0] ? ` (${s.callers[0]})` : '';
		if (s.errors) {
			warn('span-errors', `${s.name} failed ${s.errors} time${s.errors === 1 ? '' : 's'}${site}.`, {
				fix: 'A failed span is a request that paid for work it could not use — read the error on the Spans table.'
			});
		}
		if (s.open) {
			warn(
				'span-open',
				`${s.name} never ended ${s.open} time${s.open === 1 ? '' : 's'}${site} — a hung call, or a span.start() without end().`
			);
		}
		const wall_per_render = s.wall_ms / runs;
		if (per_render >= 5 && wall_per_render >= Math.max(5, window_ms * 0.05)) {
			// the breakdown's biggest value, when the spans carry one (`ds.render` by tag)
			const bk = Object.keys(s.by)[0];
			const top = bk ? s.by[bk][0] : undefined;
			const overlap = s.wall_ms < s.total_ms * 0.6;
			// ran together, each value's part of the wall is its fair share (the shares add up to the
			// wall); summed start-to-ends would count every instant once per span open in it
			const top_share = top ? [...s.by[bk]].sort((x, y) => y.share_ms - x.share_ms)[0] : undefined;
			const by_top = overlap
				? top_share &&
					bk &&
					!top_share.value.startsWith('(') &&
					top_share.share_ms >= s.wall_ms * 0.2
					? ` The biggest part is ${bk} ${top_share.value}: ${Math.round(top_share.count / runs)} of them, ${fmt_ms(top_share.share_ms / runs)} ms of the ${fmt_ms(wall_per_render)} ms (${fmt_pct(top_share.share_ms, s.wall_ms)}).`
					: ''
				: // "most of it" only when it is: 1 of 16 equal lookups (a key per call, repeated each render) is not
					top && bk && !top.value.startsWith('(') && top.wall_ms >= s.wall_ms * 0.2
					? ` Most of it is ${bk} ${top.value}: ${Math.round(top.count / runs)} of them, ${fmt_ms(top.wall_ms / runs)} ms of wall.`
					: '';
			// ran together (a Promise.all: the summed time is far above the wall) or one after another?
			if (overlap) {
				warn(
					'span-repeat',
					`${s.name} ran ${Math.round(per_render)} times ${in_one}${site}, up to ${s.peak} at once, and together they took ${fmt_ms(wall_per_render)} ms. ` +
						`Each one's part of that is about ${fmt_ms(s.share_p50_ms)} ms; its own start to end (${fmt_ms(s.p50_ms)} ms) is mostly waiting its turn behind the others.${by_top}`,
					{
						fix: 'They already overlap, so batching gains little: the cost is each one (make it cheaper, or cache it) and how many there are (render fewer).'
					}
				);
			} else {
				warn(
					'span-repeat',
					`${s.name} ran ${Math.round(per_render)} times ${in_one}${site}, ${fmt_ms(ms_per_render)} ms together, ${fmt_ms(s.p50_ms)} ms each.${by_top}`,
					{
						fix: 'Once per item is the N+1 shape: batch it (one call for all the ids), or fetch the parent with its children included.'
					}
				);
			}
		} else if ((s.wall_ms < s.total_ms * 0.6 ? wall_per_render : ms_per_render) >= Math.max(10, window_ms * 0.2)) {
			// calls that ran together cost their wall, not their sum (242 overlapping calls summed to
			// 15.8 s inside a 6 s window)
			const together = s.wall_ms < s.total_ms * 0.6;
			const took = together ? wall_per_render : ms_per_render;
			warn(
				'span-slow',
				`${s.name} took ${fmt_ms(took)} ms of the ${meta.trigger === 'window' ? 'window' : 'render'}${site}${per_render > 1 ? `, over ${Math.round(per_render)} calls${together ? ` running together (${fmt_ms(ms_per_render)} ms summed)` : ''}` : ''}.`,
				{
					fix: 'The profiler cannot see inside it — this is the wait to take to whoever owns that service, or to cache.'
				}
			);
		}
		if (s.cache && s.cache.miss_ms / runs >= Math.max(5, window_ms * 0.05)) {
			warn(
				'cache-misses',
				`${s.name}: ${Math.round(s.cache.miss / runs)} cache miss${s.cache.miss / runs >= 2 ? 'es' : ''} per render cost ${fmt_ms(s.cache.miss_ms / runs)} ms (${s.cache.hit} hit${s.cache.hit === 1 ? '' : 's'} in the window).`,
				{
					fix: 'A miss on every render is no cache: check the key, the TTL, or whether the cache is per-instance on a host that spins instances up per request.'
				}
			);
		}
	}
	// KIT'S ETAG: `render_response` hashes the whole HTML for an ETag on every render (csr=false
	// pages included) — a cost that scales with the document, not with the app's work.
	const etag = a.functions.find((f) => f.name === 'hash' && f.pkg === '@sveltejs/kit');
	if (etag && etag.self_ms >= a.busy_ms * 0.03 && etag.self_ms >= 3) {
		const bytes = meta.run_bytes ?? meta.requests.find((r) => r.internal)?.og?.tail_bytes;
		info(
			'kit-etag',
			`Kit hashed the whole HTML for its ETag: ${fmt_ms(pr(etag.self_ms))} ms per render` +
				(bytes ? ` over ${fmt_kb(bytes)}` : '') +
				'.',
			{
				anchor: `fn:${etag.key}`,
				fix: 'Only a smaller document helps (fewer bytes in the seed and props, less markup) — the hash itself is Kit’s, not yours.'
			}
		);
	}
	// OGYGIA'S OWN COST on the profiled page.
	const og = [...meta.requests]
		.filter((r) => r.og)
		.sort(
			(x, y) => y.og!.seed_bytes + y.og!.tail_bytes - (x.og!.seed_bytes + x.og!.tail_bytes)
		)[0]?.og;
	if (og) {
		info(
			'ogygia-cost',
			`ogygia added ${fmt_ms(og.transform_ms)} ms to the render: ${og.islands} island${og.islands === 1 ? '' : 's'}` +
				(og.holes ? `, ${og.holes} hole${og.holes === 1 ? '' : 's'}` : '') +
				`, seed ${fmt_kb(og.seed_bytes)}, props ${fmt_kb(og.tail_bytes)}` +
				(og.remote_seed_bytes ? `, remote seed ${fmt_kb(og.remote_seed_bytes)}` : '') +
				'.'
		);
		if (og.seed_bytes > 100 * 1024) {
			warn(
				'seed-large',
				`The page seed is ${fmt_kb(og.seed_bytes)}: an island reads $page, so that much of page.data ships to the browser and is serialized on every render.`,
				{
					fix: 'Read only the keys the island needs (page.data.x, not page.data) so seed shaping trims it, or pass the values as props.'
				}
			);
		}
		if (og.tail_bytes > 200 * 1024) {
			warn(
				'props-large',
				`Island props total ${fmt_kb(og.tail_bytes)} across ${og.islands} islands.`,
				{
					fix: 'Pass each island the slice it renders, not the whole record; a prop that is a page.data node crosses as a reference for free.'
				}
			);
		}
		ogygia_findings(og, meta, extras, info, warn);
	}
	page_weight_findings(meta, extras, info, warn);
	// A PAGE OF MANY ELEMENTS, from the HTML itself (no visit, or a visit that did not measure it):
	// the same words the browser's count gets, which leads when a visit has it
	const els = extras.strip?.elements;
	if (els && els.total >= DOM_LARGE && !extras.visit?.dom) {
		const top = els.islands[0];
		const row = top && top.n >= els.total * 0.3 ? island_rows_of(meta).find((r) => r.fp === top.fp) : undefined;
		const name = row?.name || (top ? `the island ${top.fp.slice(0, 8)}` : '');
		const held = top && top.n >= els.total * 0.3;
		const n = (x: number) => x.toLocaleString('en-US');
		warn(
			'dom-large',
			`The HTML makes ${n(els.total)} elements` +
				(held
					? `, ${n(top.n)} of them inside ${name}: an island hydrates over every element of its own, so it pays for all of them as it wakes.`
					: ': every element costs the browser memory and style and layout work on each change.'),
			{
				fix: held
					? `Render fewer at once in ${name}: page or window a long list (only what is on screen), and keep big static markup outside the island (a lake costs nothing to hydrate).`
					: 'Render fewer at once: page or window long lists (only what is on screen), and flatten markup that nests wrappers for layout alone.'
			}
		);
	}
	// what held the profiled render's document open: its streamed promises by page.data key
	const tail = extras.strip?.tail;
	const held_open: HeldOpen | undefined = tail?.keys.length
		? { side: 'server', keys: tail.keys.map((k) => ({ key: k.key, at: k.left_ms })), early_ms: tail.early_ms, early_bytes: tail.early_bytes, late_ms: tail.late_ms, late_bytes: tail.late_bytes, islands: island_rows_of(meta).length }
		: undefined;
	// (no visit: the render alone says it — the same finding, from the server's side)
	if (!extras.visit && held_open) {
		const f = explain_held_open({ vitals: {}, visit: null, islands: [], firsts: [], shifts: [], longtasks: [], held_open }, [], (fp) => fp);
		if (f) warn(f.code, f.message, { fix: f.fix });
	}
	// THE BROWSER'S FINDINGS: the devtools Page tab's analysis of the visit, word for word
	if (extras.visit) {
		// third parties: every origin but the page's; what the page names = everything weighed from its
		// HTML and imports; main-thread time per host from the browser CPU
		// (the visit's own origin first; a dev server weighs nothing, so what the page named is then
		// unknown and parse time decides what a script loaded)
		const origin = extras.visit.origin || page_origin(extras.assets);
		const third = origin ? { origin, named: extras.assets?.assets.map((a) => a.url), by_host: cpu_by_host(extras) } : undefined;
		const hole_by_id = new Map((own_requests(meta).find((r) => r.og?.hole_rows?.length)?.og?.hole_rows ?? []).map((h) => [h.id, h]));
		// (a COPY by its key when the visit said which — copies of one component share the id and
		// differ by props; without a key, a component with several copies is named bare: no copy's
		// props stand for the others)
		const hole_name = (id: string, p?: string) => {
			const h = hole_by_id.get(id);
			if (h) {
				const copy = p ? h.copies?.find((c) => c.p === p) : undefined;
				if (copy) return hole_label({ ...h, props: copy.props });
				return (h.copies?.length ?? 0) > 1 && h.name ? h.name : hole_label(h);
			}
			const own = (extras.hole_requests ?? []).find((r) => r.id === id && r.name)?.name;
			return own ?? `the hole ${id}`;
		};
		// (the hole's server render beside its browser wait: the visit's own requests of it — of
		// that copy, when known — else the ones the recording holds, per request)
		const econ = hole_economics(meta);
		const hole_server = (id: string, p?: string) => {
			const of_id = (extras.hole_requests ?? []).filter((r) => r.id === id);
			const of_copy = p ? of_id.filter((r) => r.p === p) : [];
			const own = of_copy.length ? of_copy : of_id;
			if (own.length) return own.reduce((a, r) => a + r.ms, 0) / own.length;
			const e = econ.get(id);
			const n = e ? e.hit + e.miss + e.none : 0;
			return e && n ? e.ms / n : undefined;
		};
		// (each in-app navigation with its page request's server side, from the request log)
		const nav_req = new Map((extras.nav_requests ?? []).map((r) => [r.t, r]));
		const visit = nav_req.size && extras.visit.navs ? { ...extras.visit, navs: extras.visit.navs.map((n) => (nav_req.has(n.t) ? { ...n, on_server: nav_req.get(n.t)! } : n)) } : extras.visit;
		// (the blocking files: the report's own finding when it weighed the page; else the browser's timing)
		out.push(...browser_findings(browser_page_report(visit, island_rows_of(meta), extras.client_cpu?.windows, third, hole_name, hole_server, extras.interaction_cpu, !!meta.dev, held_open)).filter((f) => f.code !== 'render-blocking' || !extras.assets));
		// what the visiting browser could not see: those findings cannot appear, whatever the page does
		const WHAT: Record<string, string> = { 'layout-shift': 'layout shifts', longtask: 'long tasks', event: 'interaction timing', 'largest-contentful-paint': 'the largest paint', 'long-animation-frame': 'which script held a frame' };
		const blind = (extras.visit.unsupported ?? []).map((t) => WHAT[t]).filter(Boolean);
		if (blind.length)
			info(
				'browser-limits',
				`The browser that visited does not report ${blind.join(', ')}: findings and score parts that need them are missing from this report, not clean. Visit the page from a Chromium browser to measure them.`
			);
	}
	kit_findings(a, meta, info, warn);
	accuracy_findings(a, meta, extras, info, warn);
	// PATHS: several hot functions under one caller — the one place to fix (the graph is below)
	for (const g of (a.paths ?? []).slice(0, 3)) {
		const say = g.ms >= a.busy_ms * 0.15 ? warn : info;
		say(
			'path-group',
			`${g.fns.length} hot functions sit on one path under ${g.owner.name}: ${g.fns
				.slice(0, 4)
				.map((f) => f.name)
				.join(
					', '
				)}${g.fns.length > 4 ? ` and ${g.fns.length - 4} more` : ''} — ${fmt_ms(pr(g.ms))} ms together${per_r} (${fmt_pct(g.ms, a.busy_ms)} of busy).`,
			{
				anchor: g.owner.category === 'component' ? `comp:${g.owner.name}` : `fn:${g.owner.key}`,
				file: g.owner.url,
				line: g.owner.line,
				fix: `Fix ${g.owner.name} once — call it less, cache what it computes, or move it out of the render — rather than each function on its own; the graph under "Paths to fix" shows the chain.`
			}
		);
	}

	// (5 ms of collection PER RENDER: the window's total over a page that mostly sleeps — 6 ms of GC in
	// 10 ms of CPU across two 800 ms renders — read as "60% of busy time", true and trivial)
	if (a.gc_ms > a.busy_ms * 0.15 && a.gc_ms / runs_of(meta) > 5) {
		warn(
			'gc-heavy',
			`Garbage collection took ${fmt_pct(a.gc_ms, a.busy_ms)} of busy time (${fmt_ms(pr(a.gc_ms))} ms${per_r}) — see the allocators for who creates the garbage.`
		);
	}
	// WHAT A RENDER LEAVES BEHIND: the heap kept after one more render and a full collection
	if (extras.retained && extras.retained.total_bytes >= 5 * 1048576) {
		const r = extras.retained;
		const top = r.sites
			.slice(0, 3)
			.map(
				(s) =>
					`${s.name}${s.caller ? ` via ${s.caller}` : ''}${s.component ? ` in ${s.component}` : ''} (${Math.round((s.bytes / 1048576) * 10) / 10} MB)`
			)
			.join(', ');
		const mb = r.total_bytes / 1048576;
		// THE RUNWAY: how many more renders until the heap limit (or the Lambda's memory) kills it
		const limit = meta.lambda ? meta.lambda_mb : meta.heap_limit_mb;
		const runway = limit ? Math.max(1, Math.floor(limit / mb)) : null;
		// the kept memory comes from a package (a server renderer, an SDK), not the app's own code
		const pkg_of = (file: string): string | null => {
			const at = file.lastIndexOf('/node_modules/');
			if (at === -1) return null;
			const parts = file.slice(at + 14).split('/');
			return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
		};
		const from_pkg = r.sites.filter((s) => s.url && pkg_of(s.url));
		const pkg_share = from_pkg.reduce((sum, s) => sum + s.bytes, 0) / r.total_bytes;
		const pkg = pkg_share >= 0.5 ? pkg_of(from_pkg[0].url) : null;
		warn(
			'retained-per-render',
			`One render leaves ${Math.round(mb * 10) / 10} MB alive after a full collection: ${top}. Every render adds that much; the instance grows until it restarts` +
				(runway ? ` — at this rate its ${limit} MB ${meta.lambda ? 'of memory' : 'heap'} runs out after about ${runway} render${runway === 1 ? '' : 's'} of this page, and the process dies.` : '.') +
				(pkg ? ` ${Math.round(pkg_share * 100)}% of it is held inside ${pkg}.` : ''),
			{
				fix: pkg
					? `The kept memory is ${pkg}'s: called once per render (or per element), it keeps each call's state. Call it once and reuse it — one instance or one document-wide pass instead of one call per element — and check the package's issues for a dispose or cleanup call; restarting workers every N requests is only a stopgap.`
					: 'Whatever holds these (a module-level cache, a registry, a closure kept by a long-lived object) must release them or be bounded. The sites named are where the kept objects were made; what keeps them is their owner.',
				...(r.sites[0]?.url ? { file: r.sites[0].url, line: r.sites[0].line } : {})
			}
		);
	}
	// DEOPTIMIZATIONS: a hot function V8 keeps throwing out of optimized code
	for (const d of a.deopts.slice(0, 3)) {
		if (d.self_ms < Math.max(2, a.busy_ms * 0.01) || d.count < 2) continue;
		const why = Object.entries(d.reasons)
			.sort((x, y) => y[1] - x[1])
			.map(([r, n]) => `${r} ×${n}`)
			.join(', ');
		warn(
			'deopt',
			`${d.name} was deoptimized ${d.count} times in the window (${why}) and cost ${fmt_ms(pr(d.self_ms))} ms of CPU${per_r}: it runs in slow code most of the time.`,
			{
				fix: 'A deopt reason names the assumption that broke: "wrong map" is objects of different shapes at one site (keep the same properties in the same order), "not a Smi" is a number that became a float or a string, a megamorphic call site is many types through one call. Give the function one shape and it stays optimized.',
				anchor: `fn:${d.key}`,
				file: d.url,
				line: d.line
			}
		);
	}
	// SYNC I/O inside the render: blocks every other request on the instance
	// (on the dev server, a read no app code called is the dev server loading modules: no build has it)
	const sync = sync_io(a).filter((r) => !meta.dev || r.callers.length);
	const sync_ms = sync.reduce((s, r) => s + r.total_ms, 0);
	if (sync_ms >= 2) {
		const top = sync[0];
		warn(
			'sync-io',
			`${fmt_ms(pr(sync_ms))} ms of synchronous I/O on the CPU${R > 1 ? ' per render' : ' during the window'}: ${sync
				.slice(0, 3)
				.map(
					(s) =>
						`${s.name} ${fmt_ms(pr(s.total_ms))} ms${s.callers[0] ? ` from ${s.callers[0]}` : ''}`
				)
				.join(', ')}. While it runs no other request on this instance moves.`,
			{
				fix: 'Use the async form (fs.promises, zlib promises, execFile with a callback), or do it once at start-up and keep the result.',
				anchor: `fn:${top.key}`
			}
		);
	}
	// PROMISE STORM: tens of thousands of promises per render is a cost no function shows
	if (extras.promises) {
		const all = meta.runs?.length
			? extras.promises.count / meta.runs.length
			: extras.promises.count;
		// on the dev server, the dev server's own module loading (its file reads, its resolver) makes
		// most of them: no build has it, and the app cannot change it — left out, and said so
		const dev_share = meta.dev ? extras.promises.top.reduce((s, t) => s + (dev_tool_caller(t.caller) ? t.share : 0), 0) : 0;
		const per = all * (1 - Math.min(dev_share, 1));
		if (per >= 10_000) {
			const rest = 1 - dev_share || 1;
			const top = extras.promises.top
				.filter((t) => !meta.dev || !dev_tool_caller(t.caller))
				.slice(0, 3)
				.map((t) => `${t.caller} ${Math.round((t.share / rest) * 100)}%`)
				.join(', ');
			const left_out = dev_share >= 0.05 ? ` (the dev server's own module loading made about ${Math.round(all - per).toLocaleString()} more, left out)` : '';
			warn(
				'promise-storm',
				`${Math.round(per).toLocaleString()} promises per render${left_out}. Each is an allocation and a microtask; at this volume they are a cost no single function shows.${top ? ` Mostly from: ${top}.` : left_out ? ' Their makers are spread thin: no one origin of the app’s stands out in the sample — profile again warm (the dev server’s loading crowds a first render).' : ''}`,
				{
					fix: 'Find the loop that awaits per item (a render per tag, a fetch per row) and do the work in one call, or on a plain array without async at all.'
				}
			);
		}
	}
	// A TIMER EACH RENDER STARTS AND NEVER ENDS: still open after every render, from the same line
	{
		const by = new Map<string, { caller: string; n: number; repeat?: number; delay?: number; at?: { path: string; line: number } }>();
		for (const o of extras.io ?? []) {
			if (!o.left_each_run || !o.caller) continue;
			const g = by.get(o.caller) ?? { caller: o.caller, n: 0, ...(o.repeat !== undefined ? { repeat: o.repeat } : { delay: o.delay }), ...(o.caller_at ? { at: o.caller_at } : {}) };
			g.n++;
			by.set(o.caller, g);
		}
		for (const g of [...by.values()].slice(0, 2)) {
			const s = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`);
			const what =
				g.repeat !== undefined
					? `starts an interval (every ${s(g.repeat)}) that is still running after the render`
					: `schedules a ${s(g.delay ?? 0)} timer that is still waiting after the response went out`;
			warn(
				'render-leftover',
				`Each render ${what}: ${g.caller}. Every render adds ${g.n === 1 ? 'one' : g.n} more — under traffic they pile up, each keeping its request's data in memory${g.repeat !== undefined ? ' and running on the instance’s CPU' : ''}.`,
				{
					fix:
						g.repeat !== undefined
							? 'Start it once for the process (at module level, or behind a flag set on first use) and share what it keeps fresh, or clear it when the work it serves is done. A render should leave nothing running.'
							: 'Clear the timer when the work it guards finishes, or keep one process-wide timer (a cache sweep) instead of one per request.',
					...(g.at ? { file: g.at.path, line: g.at.line } : {})
				}
			);
		}
	}
	// MEMOIZATION CANDIDATES: the same computation many times per render
	for (const m of memo_candidates(a, extras.gc_attr?.makers ?? [], 8, runs_of(meta)).slice(0, 2)) {
		info(
			'memo-candidate',
			`${m.name} runs ${m.calls} times per render at ${m.per_call_ms} ms each (${fmt_ms(m.total_ms)} ms)${m.alloc_per_call ? `, allocating ${Math.round(m.alloc_per_call / 1024)} KB per call` : ''}${m.parent ? `, mostly under ${m.parent}` : ''}. If its result depends only on its argument, a cache keyed on it runs it once per distinct value.`,
			{
				anchor: `fn:${m.key}`,
				file: m.url,
				line: m.line
			}
		);
	}
	// WHO CAUSED THE GC: the allocator carrying the most pause time, when it is worth naming
	const g = extras.gc_attr;
	if (g && g.summary.total_ms >= 5 && g.makers.length) {
		const m = g.makers[0];
		if (m.gc_ms >= 3 && m.share >= 0.15) {
			const where = m.component && m.component !== m.name ? ` inside ${m.component}` : '';
			const via = m.caller && m.caller !== m.name ? ` (called from ${m.caller})` : '';
			warn(
				'gc-cause',
				`${fmt_ms(pr(m.gc_ms))} ms of the ${fmt_ms(pr(g.summary.total_ms))} ms of GC${per_r} is the garbage ${m.name}${via} makes${where}: ${Math.round((pr(m.allocated) / 1048576) * 10) / 10} MB of the ${Math.round(pr(g.summary.allocated_mb) * 10) / 10} MB allocated${R > 1 ? ' per render' : ' in the window'} (${Math.round(m.share * 100)}%)${m.pauses ? `, on the causing side of ${m.pauses} pause${m.pauses === 1 ? '' : 's'}` : `, across the window's ${g.summary.count} pause${g.summary.count === 1 ? '' : 's'}`}.`,
				{
					fix: `Allocate less there: reuse the object between calls, avoid a clone or a JSON round trip of a large value, build strings once instead of in a loop. ${g.summary.retained_mb !== undefined && g.summary.retained_mb > 20 ? `The heap also grew ${g.summary.retained_mb} MB over the window: something keeps what it allocates.` : 'Most of it is churn: the heap did not grow with it.'}`,
					...(m.url ? { file: m.url, line: m.line } : {})
				}
			);
		}
	}
	// WHEN THE HEAP GREW: one burst that is most of the growth, and what ran then
	const al = extras.alloc;
	if (al && al.bursts.length && al.grown_mb >= 20) {
		const b = al.bursts[0];
		if (b.mb >= al.grown_mb * 0.3) {
			const who = b.running[0];
			info(
				'alloc-burst',
				`${b.mb} MB of the ${al.grown_mb} MB the heap grew came in one ${fmt_ms(b.t1 - b.t0)} ms stretch (${b.rate} MB/s)${who ? `, while ${who.label} ran` : ''}${b.gc ? ' — and a collection fell inside it, so the allocation was more than the growth shows' : ''}.`,
				{
					fix: 'Look at the allocators table for that stretch: the makers with a caller there are the ones filling the heap that fast.',
					...(who?.file ? { file: who.file } : {})
				}
			);
		}
	}
	// RENDERS LEFT OUT: another visitor of this same page overlapped them (the same lines: only the
	// clock tells the two apart)
	if (meta.runs_set_aside) {
		const kept = meta.runs?.length ?? 0;
		const total = kept + meta.runs_set_aside;
		(kept < 2 ? warn : info)(
			'runs-set-aside',
			`${meta.runs_set_aside} of the ${total} renders ran while another visitor asked for this same page, and were left out: their work runs the same lines, so nothing but the clock tells it apart. The report reads the ${kept} render${kept === 1 ? '' : 's'} that ran clean.`,
			kept < 2
				? { fix: 'Record again when the page is quieter (or on an instance out of rotation) for more than one clean render.' }
				: {}
		);
	}
	// THE INSTANCE WAS NOT ALONE
	const ct = extras.contention;
	if (ct && ct.requests.length) {
		const others = ct.requests.filter((r) => r.kind === 'other');
		const others_n = ct.counts?.other ?? others.length;
		// holes only: the render's calls to its own server are their own kind
		const holes = ct.counts?.hole ?? ct.requests.filter((r) => r.kind === 'hole').length;
		const win = meta.trigger === 'page' ? Math.max(meta.runs?.length ?? 1, 1) : 1;
		if (others_n && ct.busy_share >= 0.1) {
			const top = others
				.slice(0, 3)
				.map((r) => `${r.method} ${r.path}`)
				.join(', ');
			// OTHER VISITORS ON THIS SAME PAGE run the same files: nothing tells their samples from the
			// profiled render's, so they cannot be set aside like another page's are
			const page_path = meta.page?.split('?')[0];
			const same = page_path ? others.filter((r) => r.path === page_path).length : 0;
			warn(
				'busy-instance',
				`${others_n} other request${others_n === 1 ? '' : 's'} ran on this instance during the profiled render${win > 1 ? 's' : ''} (${top}${others_n > 3 ? ', …' : ''}), in flight for ${Math.round(ct.busy_share * 100)}% of the window: up to ${fmt_ms(ct.cpu_max_ms)} ms of its wall time was the event loop serving them, and the render's own numbers carry that wait.${a.other_requests_ms ? ` The samples under other pages' code (${fmt_ms(a.other_requests_ms / win)} ms a render) were set aside, and so were the slow lines in their page files — but a shared helper they called after an await has no frame of theirs left to tell it by, and may still show here: profile again on a quiet instance to be sure.` : ''}${same ? (meta.runs_set_aside ? ` ${same} of them asked for this same page; the ${meta.runs_set_aside} render${meta.runs_set_aside === 1 ? '' : 's'} they overlapped ${meta.runs_set_aside === 1 ? 'was' : 'were'} left out, so this report reads the ${meta.runs?.length ?? 0} that ran clean.` : ` ${same} of them asked for this same page: their work runs through the same lines and cannot be told apart from the profiled render's (every render overlapped one), so this report's CPU reads high — up to ${same + 1}× on the lines they share.`) : ''}`,
				{
					fix: 'Record again on a quiet instance, or read the CPU numbers (they exclude the others) rather than the wall time. Sustained, this is what horizontal scaling or a worker pool is for.'
				}
			);
		}
		const selfs = ct.requests.filter((r) => r.kind === 'self');
		// the full tallies when the report has them (the list above is the heaviest 40 only)
		const self_n = ct.counts?.self ?? selfs.length;
		if (self_n) {
			const paths = ct.counts?.self_paths ?? [...new Set(selfs.map((r) => r.path))];
			const per = Math.round(self_n / win);
			const self_ms = (ct.counts?.self_ms ?? selfs.reduce((s, r) => s + r.ms, 0)) / win;
			info(
				'self-fetch',
				`The render called its own server ${per} time${per === 1 ? '' : 's'} (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}), ${fmt_ms(self_ms)} ms of requests answered by the same event loop that was rendering: the page waited on itself, and every one of those calls paid a full HTTP round trip to reach code in the same process.`,
				{
					fix: 'Call the function behind the endpoint directly from the load (import it), or use a remote function; keep fetch for servers that are not this one.'
				}
			);
		}
		if (holes && !others_n && !self_n) {
			info(
				'holes-in-flight',
				`${holes} of the page's own hole request${holes === 1 ? '' : 's'} ${holes === 1 ? 'was' : 'were'} answered while it rendered: the deferred islands cost the instance CPU on the page's own clock.`
			);
		}
	}
	// DATA LINEAGE: keys fetched for nobody, keys shipped for the server alone
	const ln = extras.lineage;
	if (ln) {
		// (a key another page's load returned — a visitor of that page overlapping the renders — is
		// not this page's to read)
		const route = own_requests(meta).find((r) => r.route)?.route ?? meta.request?.route;
		const unread = ln.unread.filter((k) => k.from && !(route && another_routes_file(route, k.from)));
		if (unread.length) {
			const names = unread
				.slice(0, 4)
				.map((k) => `${k.key} (${k.from})`)
				.join(', ');
			// each load's wait ONCE: three unread keys from one load all carry that load's wait, and
			// adding it per key counted it three times. Nor is it the saving: the same load serves the
			// keys that ARE read, and which calls feed only these keys the profile cannot say.
			const load_wait = new Map<string, number>();
			for (const k of unread)
				if ((k.load_wait_ms ?? 0) > 0 && k.from) load_wait.set(k.from, k.load_wait_ms!);
			const wait = [...load_wait.values()].reduce((s, w) => s + w, 0);
			const loads = load_wait.size;
			// THE EXACT WORK, when the drill-down tied rows to keys: the calls and computations whose
			// every key is unread — the part to cut, in one render's ms, not the whole load's wait
			const rows = unread_rows(extras.drill);
			const cut = rows.reduce((s, r) => s + r.ms, 0);
			const exact = rows.length
				? ` Exactly what builds only ${unread.length === 1 ? 'it' : 'them'}: ${rows
						.slice(0, 4)
						.map(
							(r) =>
								`${r.label} ${fmt_ms(r.ms)} ms (${r.kind === 'wait' ? 'waiting' : 'CPU'}) → ${r.keys.join(', ')}`
						)
						.join(
							', '
						)}${rows.length > 4 ? ', …' : ''} — ${fmt_ms(cut)} ms of one render for nothing.`
				: wait > 0
					? ` The load${loads > 1 ? 's' : ''} returning ${unread.length === 1 ? 'it' : 'them'} waited ${fmt_ms(wait)} ms on upstream calls per render in all; the calls that feed only ${unread.length === 1 ? 'this key' : 'these keys'} are the part to cut.`
					: '';
			warn(
				'key-unread',
				`${unread.length} page.data key${unread.length === 1 ? '' : 's'} no component reads: ${names}${unread.length > 4 ? ', …' : ''}.${exact}`,
				{
					fix: 'Drop the key from the load, or the call that produces it — nothing on the page uses it. A key read through a spread or a whole-object pass-through would show as unknown, not unread.',
					file: unread[0].from!
				}
			);
		}
		const so = ln.server_only.filter((k) => k.shipped_bytes >= 2048);
		if (so.length) {
			const bytes = so.reduce((s, k) => s + k.shipped_bytes, 0);
			info(
				'seed-server-only',
				`${fmt_kb(bytes)} of the seed is ${so.length} key${so.length === 1 ? '' : 's'} only the server renders (${so
					.slice(0, 4)
					.map((k) => k.key)
					.join(', ')}${so.length > 4 ? ', …' : ''}): shipped to the browser, read by no island.`,
				{
					fix: 'The seed ships the keys islands read; a key here is read by a server component through a name the shaping could not see. Check the island’s closure.'
				}
			);
		}
	}
	// VALUES: a span whose time follows one of its numbers
	for (const v of span_values(extras.spans)) {
		if (
			v.r !== undefined &&
			v.r >= 0.8 &&
			v.n >= 5 &&
			v.ms_per_unit !== undefined &&
			v.ms_per_unit > 0
		) {
			info(
				'value-driven',
				`${v.span} scales with ${v.attr}: about ${v.ms_per_unit >= 0.01 ? v.ms_per_unit : v.ms_per_unit.toExponential(1)} ms per unit over ${v.n} spans (${v.attr} ${v.min}–${v.max}, fit r=${v.r}). Halving the ${v.attr} halves the span.`
			);
			break;
		}
	}
	if (extras.gc && extras.gc.max_ms > 20) {
		warn(
			'gc-pause',
			`Longest single GC pause: ${fmt_ms(extras.gc.max_ms)} ms (${extras.gc.count} pauses in the window, ${fmt_ms(pr(extras.gc.total_ms))} ms${R > 1 ? ' per render' : ' total'}). A long pause freezes every request at once.`
		);
	}
	if (meta.loop_delay && meta.loop_delay.p99 > 50) {
		warn(
			'loop-stall',
			`The event loop stalled up to ${fmt_ms(meta.loop_delay.p99)} ms (p99) — long synchronous work blocks every other request.`
		);
	}
	const mem_delta = extras.mem.length >= 2 ? extras.mem.at(-1)!.rss - extras.mem[0].rss : 0;
	if (mem_delta > 50) warn('mem-growth', `Memory grew ${mem_delta} MB during the window.`);

	const profiler_ms = a.buckets.find((b) => b.key === 'profiler overhead')?.self_ms ?? 0;
	if (profiler_ms > a.busy_ms * 0.05 && profiler_ms > 5) {
		info(
			'profiler-overhead',
			`${fmt_ms(profiler_ms)} ms of busy time is the profiler itself — a one-time cost when recording starts. Your app did not pay this outside the recording.`
		);
	}
	if (meta.dev) {
		info(
			'dev-mode',
			'Recorded on the dev server — Vite module loading and transforms are included. Build and run production for exact figures.'
		);
	}
	if (extras.patterns?.length) link_patterns(out, extras.patterns, a);
	return out;
}

/** `lib/hell/ds-ssr.ts` and `src/lib/hell/ds-ssr.ts` name one file: one path ends with the other */
const same_file = (x: string, y: string) => {
	const a = x.startsWith('file://') ? x.slice(7) : x;
	const b = y.startsWith('file://') ? y.slice(7) : y;
	return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
};

/** an identifier no sentence would contain: an inner capital, an underscore or a digit */
const looks_like_code = (name: string) => {
	for (let i = 1; i < name.length; i++) {
		const c = name.charCodeAt(i);
		if ((c >= 65 && c <= 90) || c === 95 || (c >= 48 && c <= 57)) return true;
	}
	return false;
};

/** every `(path:line)` a finding's message names (a caller written `fn (lib/x.ts:46)`) */
function places_in(message: string): { file: string; line: number }[] {
	const out: { file: string; line: number }[] = [];
	let i = message.indexOf('(');
	while (i !== -1) {
		const close = message.indexOf(')', i);
		if (close === -1) break;
		const inner = message.slice(i + 1, close);
		const colon = inner.lastIndexOf(':');
		const line = colon > 0 ? Number(inner.slice(colon + 1)) : NaN;
		if (Number.isInteger(line) && line > 0 && !inner.slice(0, colon).includes(' '))
			out.push({ file: inner.slice(0, colon), line });
		// next from just past this `(`: a caller nests (`load (routes/x.ts:79)`) inside another pair
		i = message.indexOf('(', i + 1);
	}
	return out;
}

/**
 * A finding that a slow pattern already explains points at it (`pattern`, its index), so the two
 * read as one problem: a finding and a pattern share a code line (a site, a caller line, or the
 * function a site sits in), the row the finding opens is a site's function, or a network finding
 * names the calls a waits-in-a-row site made. Nothing is hidden; the finding gains the link.
 */
export function link_patterns(
	findings: Finding[],
	patterns: readonly Pattern[],
	a: Pick<Analysis, 'functions' | 'components'>
): void {
	const start_of = new Map<string, number>();
	for (const f of a.functions) start_of.set(f.key, f.line);
	for (const c of a.components) start_of.set(c.key, c.line);
	const places = patterns.map((p) => {
		const lines: { file: string; line: number }[] = [];
		const fns = new Set<string>();
		const targets: string[] = [];
		/** a site's function as a finding names a caller: `drainQueue (` */
		const callers: string[] = [];
		for (const s of p.sites) {
			lines.push({ file: s.path || s.file, line: s.line });
			// only a name that reads as code (`drainQueue`, `to_vm`, `h2`): a plain word like `render`
			// also appears in the prose of a finding ("of the render (processDsTags …)")
			if (s.fn_name && !s.fn_name.startsWith('(') && looks_like_code(s.fn_name))
				callers.push(s.fn_name + ' (');
			if (s.fn) {
				fns.add(s.fn);
				const at = start_of.get(s.fn);
				if (at) lines.push({ file: s.path || s.file, line: at });
			}
			for (const v of s.via ?? []) lines.push({ file: v.path || v.file, line: v.line });
			if (s.target) targets.push(s.target.split(' and ')[0]);
		}
		return { lines, fns, targets, callers };
	});
	// findings that ARE a pattern's subject by their code: the seed shipped whole is the
	// seed-whole-read pattern whatever the sentence says; the runs climbing and a render leaving
	// memory behind are the kept-per-render pattern (its cause, when this report caught one)
	const by_code: Record<string, string> = {
		'seed-whole': 'seed-whole-read',
		'seed-large': 'seed-whole-read',
		'retained-per-render': 'kept-per-render',
		'slower-each-run': 'kept-per-render'
	};
	for (const f of findings) {
		const kind = by_code[f.code];
		const direct = kind ? patterns.findIndex((p) => p.kind === kind) : -1;
		if (direct !== -1) {
			f.pattern = direct;
			continue;
		}
		if (f.severity !== 'warn' && f.code !== 'memo-candidate') continue;
		const mine = [
			...(f.file && f.line ? [{ file: f.file, line: f.line }] : []),
			...places_in(f.message)
		];
		const anchor_fn = f.anchor?.startsWith('fn:')
			? f.anchor.slice(3)
			: f.anchor?.startsWith('comp:')
				? 'C:' + f.anchor.slice(5)
				: undefined;
		const hit = places.findIndex(
			(p) =>
				(anchor_fn !== undefined && p.fns.has(anchor_fn)) ||
				mine.some((m) => p.lines.some((l) => l.line === m.line && same_file(l.file, m.file))) ||
				p.callers.some((c) => f.message.includes(c)) ||
				p.targets.some((t) => {
					// the finding names the target without its method (`127.0.0.1/api/product/:id`)
					const bare = t.slice(t.indexOf(' ') + 1);
					return f.message.includes(bare);
				})
		);
		if (hit !== -1) f.pattern = hit;
	}
}

type Say = (
	code: string,
	message: string,
	extra?: Pick<Finding, 'fix' | 'anchor' | 'file' | 'line'>
) => void;

/** The island rows of the profiled page: the page request that recorded them (detail is on only
 *  while the profiler records, so the internal render carries them). */
export function island_rows_of(meta: ReportMeta): IslandStat[] {
	return own_requests(meta).find((r) => r.og?.island_rows?.length)?.og?.island_rows ?? [];
}

const HOST_FN_RE = /^_[0-9a-f]{11}$/;
const ISLAND_ID_RE = /([0-9a-f]{12})/;
/**
 * THE ISLAND HOST WRAPPERS by name. The compiler wraps every island in a virtual
 * `wrapper/<id>.svelte`, and Svelte names that function after the file: `_b95bfb97fab` (the id
 * minus its first character, made an identifier). The island rows know the id (in the entry URL)
 * and the component: this returns the `rename` hook `analyze()` takes, so the wrapper reads
 * `ProductCard (island host)` in every table, stack and flame. Rows come from every request in
 * the window (a page profile's own render, a trapped page, a header-profiled request).
 */
export function island_host_renamer(
	requests: readonly RequestEntry[]
): ((name: string, url: string) => string | undefined) | undefined {
	const by_suffix = new Map<string, string>();
	for (const r of requests) {
		for (const row of r.og?.island_rows ?? []) {
			const id = ISLAND_ID_RE.exec(row.entry)?.[1];
			if (!id) continue;
			const name = island_name(row);
			if (name && name !== row.entry) by_suffix.set(id.slice(1), name);
		}
	}
	if (!by_suffix.size) return undefined;
	return (name) => {
		if (!HOST_FN_RE.test(name)) return undefined;
		const island = by_suffix.get(name.slice(1));
		return island ? `${island} (island host)` : undefined;
	};
}

/** What to call a hole: its component and props (`Recommendations {"forProduct":"P1"}`), else its id. */
export function hole_label(h: Pick<HoleStat, 'id' | 'name' | 'props'>): string {
	if (!h.name) return h.id;
	return h.props ? `${h.name} ${h.props}` : h.name;
}

/** The hole endpoint requests in the window, per hole id: hits / misses / uncached renders. */
export function hole_economics(
	meta: ReportMeta
): Map<string, { id: string; hit: number; miss: number; none: number; ms: number; ttl: number }> {
	const out = new Map<
		string,
		{ id: string; hit: number; miss: number; none: number; ms: number; ttl: number }
	>();
	for (const r of meta.requests) {
		if (!r.hole) continue;
		const e = out.get(r.hole.id) ?? {
			id: r.hole.id,
			hit: 0,
			miss: 0,
			none: 0,
			ms: 0,
			ttl: r.hole.ttl
		};
		e[r.hole.cache]++;
		e.ms += r.ms;
		out.set(r.hole.id, e);
	}
	return out;
}

/** The display name of an island: its component's name when the row carries it, else the
 *  entry's basename (`ProductCard` from `.../ProductCard.svelte`; a built facade keeps its file). */
export function island_name(row: Pick<IslandStat, 'entry' | 'name'> | string): string {
	if (typeof row !== 'string' && row.name) return row.name;
	const entry = typeof row === 'string' ? row : row.entry;
	const m = /([^/\\?]+)\.svelte(?:[?#].*)?$/.exec(entry);
	return m ? m[1] : entry.replace(/^.*[/\\]/, '') || entry;
}

/**
 * ONE ROW PER ISLAND: the tail records a row per fingerprint (a list of 48 cards is 48 props
 * sidecars, one each), and the fingerprint is what the browser's beacon joins on — but the table
 * and the findings speak of the island. Rows with the same entry and wake merge: copies and
 * bytes add up, references and hints union, the first devalue culprit stands for all, and
 * `variants` says how many fingerprints went in.
 */
export function group_islands(rows: readonly IslandStat[]): IslandStat[] {
	const out = new Map<string, IslandStat>();
	for (const r of rows) {
		const key = r.entry + '\0' + r.wake;
		const g = out.get(key);
		if (!g) {
			out.set(key, { ...r, ref_keys: [...r.ref_keys], hints: [...r.hints], variants: 1 });
			continue;
		}
		g.count += r.count;
		g.variants = (g.variants ?? 1) + 1;
		g.props_bytes += r.props_bytes;
		g.canonical_bytes += r.canonical_bytes;
		g.refs += r.refs;
		g.json = g.json && r.json;
		g.culprit ??= r.culprit;
		g.name ||= r.name;
		g.interactivity ??= r.interactivity;
		for (const k of r.ref_keys) if (!g.ref_keys.includes(k)) g.ref_keys.push(k);
		for (const h of r.hints) if (!g.hints.includes(h)) g.hints.push(h);
	}
	for (const g of out.values()) g.ref_keys.sort();
	return [...out.values()];
}

/** Unique bytes of an island's JS closure (its module + preload hints), when the weights are known. */
/** Code every page with islands loads once, never an island's own to change: the runtimes, Kit,
 *  and devalue (the runtime's decoder for rich props — the `props-devalue` finding is where that is
 *  the island's doing). The heavy-module and barrel notes leave these out. */
const FRAMEWORK = new Set(['svelte runtime', 'ogygia runtime', '@sveltejs/kit', 'devalue', 'esm-env']);

export function island_js_bytes(
	row: IslandStat,
	weights: Record<string, number> | undefined
): number | null {
	if (!weights) return null;
	let total = 0;
	let any = false;
	for (const u of new Set([row.module_url, ...row.hints])) {
		const w = u ? weights[u] : undefined;
		if (w === undefined) continue;
		any = true;
		total += w;
	}
	return any ? total : null;
}

/**
 * WHAT ONLY EACH ISLAND NEEDS: of an island's closure (its entry and chunks), the bytes no other
 * waking island on the page uses — what dropping (or deferring) that island would really save.
 * `island_js_bytes` counts shared chunks once per island; this counts each once, where it belongs.
 * Keyed by entry (copies of one island are one closure). Null without the build's weights.
 */
export function island_js_unique(rows: readonly IslandStat[], weights: Record<string, number> | undefined): Map<string, number> | null {
	if (!weights) return null;
	const waking = rows.filter((r) => r.wake !== 'none');
	const users = new Map<string, Set<string>>();
	for (const r of waking) for (const u of new Set([r.module_url, ...r.hints])) if (u) (users.get(u) ?? users.set(u, new Set()).get(u)!).add(r.entry);
	const out = new Map<string, number>();
	for (const r of waking) {
		if (out.has(r.entry)) continue;
		let only = 0;
		for (const u of new Set([r.module_url, ...r.hints])) if (u && users.get(u)?.size === 1) only += weights[u] ?? 0;
		out.set(r.entry, only);
	}
	return out;
}

/** ogygia-specific findings: the seed explained, devalue culprits, the wake advisor, hole economics,
 *  island JS weight and the browser's own hydration timings. */
function ogygia_findings(
	og: OgygiaRequestStats,
	meta: ReportMeta,
	extras: ReportExtras,
	info: Say,
	warn: Say
): void {
	const islands = group_islands(island_rows_of(meta));
	const names = (list: string[], max = 3) =>
		list.length <= max
			? list.join(', ')
			: `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
	// A FINGERPRINT THAT MOVED BETWEEN THE PROFILE'S OWN RENDERS: the same page, the same inputs —
	// a prop made fresh per render (a time, a random id). The devtools' comparison (fp-drift.ts),
	// ogygia's own ids (stores, class instances: random per render on purpose) left out.
	const renders = meta.requests.filter((r) => r.internal && r.og?.island_rows?.length).map((r) => r.og!.island_rows!);
	if (renders.length >= 2) {
		const kept = (rows: IslandStat[]) => rows.map((r) => ({ entry: r.entry, fp: r.fp, ...(r.canonical !== undefined ? { props: r.canonical } : {}) }));
		const moved = fp_compare(kept(renders[0]), kept(renders[renders.length - 1]));
		if (moved.length) {
			const name_of = (entry: string) => island_name(renders[0].find((r) => r.entry === entry) ?? entry);
			const m = moved[0];
			const whose = moved.length === 1 ? 'its' : `${name_of(m.entry)}'s`;
			const said = m.path ? `${whose} prop \`${m.path}\` was ${m.was}, then ${m.now}` : m.was !== undefined ? `${whose} props went from …${m.was}… to …${m.now}…` : `${whose} props changed`;
			info(
				'fp-unstable',
				`${names(moved.map((x) => name_of(x.entry)))} rendered with a different fingerprint on the profiler's renders of the same page: ${said}${moved.length > 1 ? ` (and ${moved.length - 1} more)` : ''}. If the page's data did not change between them, that value is made fresh on every render.`,
				{
					fix: 'The router compares fingerprints to keep a live island across a navigation, and the fingerprint is part of the page’s bytes: an island whose props change on every render is patched on every navigation, and a cache keyed on the HTML (a CDN, a post-render cache, a freeze store, an ETag) misses every time. Make the value the same for the same inputs: take it from load data, compute it in the browser (an effect), or leave it out of the props.'
				}
			);
		}
	}
	// THE SEED EXPLAINED: which key weighs, who asked for it, and why everything ships when it does.
	if (og.seed && og.seed_bytes > 0) {
		const shipped = og.seed.keys.filter((k) => k.shipped);
		const top = shipped[0];
		if (og.seed.whole_by.length) {
			warn(
				'seed-whole',
				`${names(og.seed.whole_by.map(island_name))} read${og.seed.whole_by.length === 1 ? 's' : ''} page.data whole, so every key ships in the seed (${fmt_kb(og.seed_bytes)}${top ? `, the biggest is ${top.key} at ${fmt_kb(top.bytes)}` : ''}).`,
				{
					fix: 'Read the keys by name (page.data.catalog, not a spread or a loop over page.data) so seed shaping can drop the rest, or pass the values in as props.'
				}
			);
		} else if (top && top.bytes >= 20 * 1024) {
			const why =
				top.reason === 'read'
					? `read by ${names(top.readers.map(island_name))}`
					: top.reason === 'referenced'
						? `props of ${names(top.referenced_by.map(island_name))} point into it`
						: 'shipped';
			info(
				'seed-explainer',
				`The seed's biggest key is ${top.key} (${fmt_kb(top.bytes)} of ${fmt_kb(og.seed_bytes)}): ${why}.` +
					(shipped.length > 1 ? ` ${shipped.length} keys ship in all.` : ''),
				{
					fix:
						top.reason === 'read'
							? 'If the island needs only part of it, return that part from load under its own key, or pass it as a prop.'
							: 'A referenced key ships once and the props point into it — that is the cheap shape; trim the key itself if it is bigger than the page needs.'
				}
			);
		}
	}
	// DEVALUE CULPRITS: the one leaf that took the seed, or an island's props, off the JSON lane.
	if (og.seed_bytes > 0 && !og.seed_json && og.seed_culprit) {
		warn(
			'seed-devalue',
			`The seed (${fmt_kb(og.seed_bytes)}) left the JSON lane because of ${og.seed_culprit} — devalue writes and revives it several times slower than JSON.parse.`,
			{
				fix: 'Send that value as a plain string or number (a Date as toISOString(), a Map as an object), or keep it out of page.data.'
			}
		);
	}
	const devalued = islands
		.filter((r) => !r.json && r.culprit)
		.sort((x, y) => y.props_bytes - x.props_bytes);
	if (devalued.length) {
		const d = devalued[0];
		const say = d.props_bytes >= 2048 ? warn : info;
		say(
			'props-devalue',
			`${island_name(d)}'s props (${fmt_kb(d.props_bytes)}${d.count > 1 ? `, ×${d.count}` : ''}) use devalue because of ${d.culprit}` +
				(devalued.length > 1
					? `; ${devalued.length - 1} more island${devalued.length > 2 ? 's' : ''} likewise.`
					: '.'),
			{
				fix: 'JSON props parse on the fast lane in the browser: pass the value as a string or number, or derive it inside the island.'
			}
		);
	}
	// THE WAKE ADVISOR: an island whose components carry no interactivity at all ships JS for nothing;
	// many copies of a small interactive island each waking on their own pay per copy.
	const inert = islands.filter(
		(r) =>
			r.interactivity &&
			r.interactivity.files > 0 &&
			r.wake !== 'none' &&
			r.interactivity.handlers +
				r.interactivity.state +
				r.interactivity.effects +
				r.interactivity.binds +
				r.interactivity.actions +
				(r.interactivity.remotes ?? 0) +
				(r.interactivity.awaits ?? 0) +
				(r.interactivity.shared ?? 0) ===
				0
	);
	if (inert.length) {
		const js = inert.reduce((s, r) => s + (island_js_bytes(r, extras.weights) ?? 0), 0);
		warn(
			'wake-inert',
			`${names(inert.map(island_name))} wake${inert.length === 1 ? 's' : ''} (${names([...new Set(inert.map((r) => r.wake))])}) but the build found no event handlers, $state, $effect, bind:, use:, remote function, await or shared state in ${inert.length === 1 ? 'its' : 'their'} components` +
				(js ? ` — ${fmt_kb(js)} of JS loads for markup that never changes.` : '.'),
			{
				fix: "Ship them as lakes (wake: 'none'): the server markup stays, the module never downloads."
			}
		);
	}
	const crowds = islands.filter(
		(r) => r.count >= 10 && (r.wake === 'load' || r.wake === 'idle' || r.wake === 'visible')
	);
	for (const c of crowds.slice(0, 2)) {
		info(
			'wake-crowd',
			`${island_name(c)} has ${c.count} copies on the page, each waking on ${c.wake} with its own ${fmt_kb(Math.round(c.props_bytes / Math.max(c.variants ?? 1, 1)))} of props.`,
			{
				fix: "One island around the list hydrates once; or wake: 'interaction' so a copy pays only when touched."
			}
		);
	}
	// ISLAND JS WEIGHT: the closure every waking island pulls, unique across the page.
	if (extras.weights) {
		const seen = new Set<string>();
		let total = 0;
		let heaviest: { row: IslandStat; bytes: number } | null = null;
		for (const r of islands) {
			if (r.wake === 'none') continue;
			const b = island_js_bytes(r, extras.weights) ?? 0;
			if (!heaviest || b > heaviest.bytes) heaviest = { row: r, bytes: b };
			for (const u of [r.module_url, ...r.hints]) {
				if (!u || seen.has(u)) continue;
				seen.add(u);
				total += extras.weights[u] ?? 0;
			}
		}
		// the island worth acting on: the most bytes only it needs (its closure's shared part stays
		// whether it goes or not — "alone pulls" once named the closure, shared code included)
		const unique = island_js_unique(islands, extras.weights);
		let mine: { row: IslandStat; bytes: number } | null = null;
		if (unique) for (const r of islands) if (r.wake !== 'none' && (!mine || (unique.get(r.entry) ?? 0) > mine.bytes)) mine = { row: r, bytes: unique.get(r.entry) ?? 0 };
		if (total >= 300 * 1024 && heaviest) {
			const pick = mine && mine.bytes >= 20 * 1024 ? mine : null;
			warn(
				'islands-js-heavy',
				`The page's islands load ${fmt_kb(total)} of JS in all (${seen.size} modules)` +
					(pick
						? `; ${fmt_kb(pick.bytes)} of it is needed by ${island_name(pick.row)} alone` +
							((island_js_bytes(pick.row, extras.weights) ?? 0) - pick.bytes >= 1024
								? ` (its whole closure is ${fmt_kb(island_js_bytes(pick.row, extras.weights) ?? 0)}; the rest is shared with other islands)`
								: '') +
							' — deferring or dropping it saves that much.'
						: `; ${island_name(heaviest.row)}'s closure is the largest (${fmt_kb(heaviest.bytes)}), but most of it is shared with other islands: no single island's removal saves much.`),
				{
					fix: 'Open the Islands table: a heavy closure is usually one import (a date or i18n library, a whole component kit) reachable from the island — move it server-side or behind a dynamic import.'
				}
			);
		}
	}
	// ONE MODULE IS MOST OF AN ISLAND'S CODE (the build's rendered sizes): the one place to split,
	// load later or keep on the server. The runtimes are left out of both sides: they load once per
	// page and are not the island's to change.
	if (extras.heavy && islands.length) {
		const found = new Map<string, { row: IslandStat; bytes: number; of: number }>();
		for (const r of islands) {
			if (r.wake === 'none') continue;
			let own = 0;
			const by = new Map<string, number>();
			for (const u of new Set([r.module_url, ...r.hints])) {
				const h = u ? extras.heavy[u] : undefined;
				if (!h) continue;
				own += h.total;
				for (const m of h.top) {
					if (FRAMEWORK.has(m.name)) own -= m.bytes;
					else by.set(m.name, (by.get(m.name) ?? 0) + m.bytes);
				}
			}
			const top = [...by].sort((a, b) => b[1] - a[1])[0];
			if (!top || own <= 0) continue;
			const [name, bytes] = top;
			if (bytes < 20 * 1024 || bytes < own * 0.4) continue;
			const prev = found.get(name);
			if (!prev || bytes / own > prev.bytes / prev.of) found.set(name, { row: r, bytes, of: own });
		}
		if (found.size) {
			const list = [...found].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 3);
			info(
				'island-heavy-module',
				list.map(([name, f]) => `${name.split('/').pop()} is ${Math.round((f.bytes / f.of) * 100)}% of ${island_name(f.row)}'s own code (${fmt_kb(f.bytes)} of ${fmt_kb(f.of)}, before minifying)`).join('; ') + '.',
				{ fix: 'That one module is where the island’s weight is: split it (one module per piece: an icon, a locale), load it when it is needed, or render it on the server.' }
			);
		}
	}
	// A BARREL AN ISLAND STILL IMPORTS WHOLE (the build's module info): every module it re-exports
	// ships with the island. The barrel pass left it (a side effect, or the pass is off).
	if (extras.barrels && islands.length) {
		const found = new Map<string, { row: IslandStat; fanout: number }>();
		for (const r of islands) {
			if (r.wake === 'none') continue;
			for (const u of new Set([r.module_url, ...r.hints])) {
				for (const b of (u ? extras.barrels[u] : undefined) ?? []) {
					// (Svelte's and Kit's own indexes look like barrels: shared once per page, not the island's)
					if (FRAMEWORK.has(b.name)) continue;
					const prev = found.get(b.name);
					if (!prev || b.fanout > prev.fanout) found.set(b.name, { row: r, fanout: b.fanout });
				}
			}
		}
		if (found.size) {
			const list = [...found].sort((a, b) => b[1].fanout - a[1].fanout).slice(0, 3);
			warn(
				'island-barrel',
				list.map(([name, f]) => `${island_name(f.row)} ships a barrel whole: ${name}, and the ${f.fanout} modules behind it`).join('; ') + '. A Svelte component is never side-effect free to the bundler, so what the island does not use ships anyway.',
				{ fix: 'Import what the island uses from its own file, or turn on ogygia({ barrels }). If it is on, the barrel has side effects of its own (a statement besides its re-exports), or the build log says why it was skipped.' }
			);
		}
	}
	// HOLE ECONOMICS: a hole with a maxAge whose cache never serves, and holes with no cache at all.
	const econ = hole_economics(meta);
	const rows = og.hole_rows ?? [];
	// the endpoint only knows the id; the page's rows know the component and its props
	const by_id = new Map(rows.map((h) => [h.id, h]));
	const label = (id: string) => {
		const h = by_id.get(id);
		return h ? hole_label(h) : id;
	};
	for (const e of econ.values()) {
		const total = e.hit + e.miss + e.none;
		if (e.ttl > 0 && total >= 2 && e.hit === 0) {
			warn(
				'hole-cache-cold',
				`The hole ${label(e.id)} has maxAge ${e.ttl}s but its cache never hit in ${total} requests (${fmt_ms(e.ms / total)} ms each).`,
				{
					fix: 'The cache key carries the props and the session seal: per-visitor props (a user id, a timestamp) make every key unique. Pass only what the hole renders from.'
				}
			);
		} else if (e.ttl > 0 && e.hit > 0) {
			info(
				'hole-cache',
				`The hole ${label(e.id)}: ${e.hit} of ${total} requests served from the render cache (maxAge ${e.ttl}s).`
			);
		}
	}
	const uncached = rows.filter((h) => h.ttl === 0);
	if (uncached.length && econ.size) {
		const slow = [...econ.values()].filter(
			(e) => e.ttl === 0 && e.ms / Math.max(e.hit + e.miss + e.none, 1) >= 20
		);
		if (slow.length) {
			info(
				'hole-uncached',
				`${slow.length} hole${slow.length === 1 ? '' : 's'} render${slow.length === 1 ? 's' : ''} fresh on every visit: ${names(slow.map((e) => `${label(e.id)} at ${fmt_ms(e.ms / Math.max(e.hit + e.miss + e.none, 1))} ms`))}.`,
				{
					fix: "Content that is the same for every visitor for a while can take a maxAge (a preset: { render: 'deferred', maxAge: '5m' }): the endpoint then serves the memo."
				}
			);
		}
	}
	// THE BROWSER'S SIDE: hydration timings the runtime beaconed, joined by fingerprint.
	const client = extras.client ?? [];
	// NEVER WOKE: the beacon works (other islands reported) but an island that should wake never
	// did — nothing scrolled it into view, its wake threw, or something on the page stopped it
	if (client.length) {
		const seen = new Set(client.map((c) => c.entry));
		// (one the visit saw fail is the browser's hydrate-failed finding, with its error)
		for (const r of extras.visit?.regions ?? []) if (r.failed !== undefined && r.entry) seen.add(r.entry);
		const silent = islands.filter(
			(r) => (r.wake === 'load' || r.wake === 'idle' || r.wake === 'visible') && !seen.has(r.entry)
		);
		if (silent.length) {
			warn(
				'never-hydrated',
				`${names(silent.map((r) => `${island_name(r)} (${r.count > 1 ? `${r.count} copies, ` : ''}wake: ${r.wake})`))} never reported hydrating in your visits, while ${client.length} other island${client.length === 1 ? '' : 's'} did.`,
				{
					fix: "A 'visible' island that never intersects the viewport never wakes: check the page can scroll (a design system's stylesheet can pin the body) and that the island is not hidden. A 'load' island that stays silent threw on wake: the browser console has it."
				}
			);
		}
	}
	// HYDRATION MISMATCH: an island that threw its server DOM away and re-rendered paid twice and
	// flashed — the markup changed between the server and the browser
	const broken = client.filter((c) => c.recovered > 0);
	if (broken.length) {
		const total = broken.reduce((s, c) => s + c.recovered, 0);
		warn(
			'hydration-mismatch',
			`${names(broken.map(island_name))} discarded ${broken.length === 1 ? 'its' : 'their'} server-rendered DOM and re-rendered in the browser (${total} time${total === 1 ? '' : 's'} seen): the markup the browser found was not what the server sent.`,
			{
				fix: 'Something edits the HTML between the render and the wake — a post-SSR pass (a design-system renderer, a DSD injector), a script that runs before the runtime, a comment-stripping proxy. Keep it out of ogygia-region subtrees, or run it before ogygia’s render.'
			}
		);
	}
	if (client.length) {
		const slow = [...client].sort((x, y) => y.p50_ms - x.p50_ms)[0];
		// a row is a component (one entry): its copies are every fingerprint of that entry. "3 islands"
		// on a page with 280 awake ones, and a sum of medians, read as nonsense at scale
		const rows = island_rows_of(meta);
		const copies_of = (entry: string) => rows.filter((r) => r.entry === entry).reduce((s, r) => s + (r.count || 1), 0);
		const copies = client.reduce((s, c) => s + copies_of(c.entry), 0);
		const n_slow = copies_of(slow.entry);
		// where the slowest one's time went, from this report's own visit: its modules, its turn
		// (islands hydrate one per task: many waking at once queue), the hydrate step itself
		const fps = new Set(rows.filter((r) => r.entry === slow.entry).map((r) => r.fp));
		const mine = (extras.visit?.islands ?? []).filter((i) => fps.has(i.fp) && i.done >= i.t0);
		const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : 0);
		const load = mine.length ? med(mine.map((i) => i.loaded - i.t0)) : slow.load_p50_ms;
		const wait = mine.length ? med(mine.map((i) => (i.turn !== undefined ? i.turn - i.loaded : 0))) : 0;
		// (the step to the end of its effects: Svelte runs them right after `hydrate()`)
		const step = mine.length ? med(mine.map((i) => Math.max(i.done, i.fx ?? 0) - (i.turn ?? i.loaded))) : Math.max(0, slow.p50_ms - slow.load_p50_ms);
		const whole = load + wait + step || slow.p50_ms;
		const why = load >= whole * 0.6 ? 'load' : wait >= whole * 0.5 ? 'wait' : 'step';
		// who it waited behind: the islands whose hydrate step ran inside its wait, summed by component
		let behind = '';
		let behind_name = '';
		if (why === 'wait' && mine.length) {
			const one = [...mine].sort((a, b) => (a.turn ?? a.loaded) - a.loaded - ((b.turn ?? b.loaded) - b.loaded))[mine.length >> 1];
			const w0 = one.loaded;
			const w1 = one.turn ?? one.loaded;
			const name_of = new Map(rows.map((r) => [r.fp, island_name(r)]));
			const by = new Map<string, number>();
			for (const o of extras.visit?.islands ?? []) {
				if (o === one || o.turn === undefined) continue;
				const ran = Math.min(o.done, w1) - Math.max(o.turn, w0);
				if (ran > 0) by.set(name_of.get(o.fp) ?? o.fp.slice(0, 8), (by.get(name_of.get(o.fp) ?? o.fp.slice(0, 8)) ?? 0) + ran);
			}
			const top = [...by].sort((a, b) => b[1] - a[1])[0];
			if (top && top[1] >= (w1 - w0) * 0.3) {
				behind_name = top[0];
				behind = `, most of it behind ${top[0]} (${fmt_ms(top[1])} ms of hydrating)`;
			}
		}
		const slow_wake = rows.find((r) => r.entry === slow.entry)?.wake;
		info(
			'client-hydrate',
			`In the browser, ${copies} island${copies === 1 ? '' : 's'} of ${client.length} component${client.length === 1 ? '' : 's'} reported hydration. The slowest, ${island_name(slow)}${n_slow > 1 ? ` (${n_slow} copies)` : ''}, took ${fmt_ms(slow.p50_ms)} ms from wake to hydrated at the median` +
				(mine.length ? `: ${fmt_ms(load)} ms loading its modules, ${fmt_ms(wait)} ms waiting its turn behind other islands${behind}, ${fmt_ms(step)} ms hydrating.` : load >= slow.p50_ms * 0.6 ? `, mostly loading its ${fmt_ms(load)} ms of modules.` : '.'),
			{
				fix:
					why === 'load'
						? 'Module load dominates: a smaller closure (see the Islands table) or an earlier preload helps more than faster code.'
						: why === 'wait'
							? behind
								? `It waited for its turn: islands hydrate one per task, and ${behind_name} held the queue. Make that hydrate step short (fewer elements, split the island), or wake it later.`
								: slow_wake === 'visible'
									? 'It waited for its turn: islands hydrate one per task, and many became visible at once (a fast scroll, a tall screen). Make the copies with nothing to click lakes, or render the list as one island.'
									: 'It waited for its turn: islands hydrate one per task, so many waking at once queue behind each other. Wake the ones below the first screen when visible, the rest when idle, and make the ones with nothing to click lakes.'
							: 'The hydrate step itself is slow: fewer elements per island, or split the island so the interactive part is small.'
			}
		);
	}
}

/** Kit-shaped findings: the load lanes and the parent() chain, universal loads, and the client
 *  router's serialization of load data. */
/** ms of devalue work done for Kit's copy of the server load data: each devalue function's own time,
 *  by the share of its call paths that pass through Kit's serializer (`add_node`, data_serializer.js,
 *  or render_response). A function with no recorded paths counts only when it is `uneval` itself. */
export function kit_load_serialize_ms(a: Analysis): number {
	let ms = 0;
	for (const f of a.functions) {
		if (f.pkg !== 'devalue') continue;
		const stacks = f.stacks ?? [];
		if (!stacks.length) {
			if (f.name === 'uneval') ms += f.self_ms;
			continue;
		}
		let kit = 0;
		let all = 0;
		for (const s of stacks) {
			all += s.ms;
			if (s.frames.some((fr) => fr.n === 'add_node' || fr.n === 'render_response' || fr.f.indexOf('data_serializer') !== -1)) kit += s.ms;
		}
		if (all > 0) ms += f.self_ms * (kit / all);
	}
	return ms;
}

function kit_findings(a: Analysis, meta: ReportMeta, info: Say, warn: Say): void {
	const tl = a.timeline;
	if (tl?.chain) {
		const c = tl.chain;
		// from the source: what the page waited for, and when it first used it
		const u = c.parent_use;
		const names = u ? u.names.join(', ') : '';
		const used = !u
			? ''
			: u.first_use === null
				? ` Nothing after line ${u.line} reads ${names}: the page waited on the layout for nothing.`
				: u.awaits_before_use > 0
					? ` It takes ${names} from parent() on line ${u.line} but first reads ${u.names.length === 1 ? 'it' : 'them'} on line ${u.first_use}; the ${u.awaits_before_use} await${u.awaits_before_use === 1 ? '' : 's'} between never needed the layout.`
					: '';
		warn(
			'parent-chain',
			`${c.page} started only after ${c.layout} finished (${fmt_ms(c.serial_ms)} ms later)` +
				// the source saying `await parent()` is as good as seeing its frame
				(c.explicit || u
					? ' — it awaits parent().'
					: ' — Kit runs a page load and its layout loads together unless the page awaits parent().') +
				used,
			{
				fix:
					u && u.first_use !== null && u.awaits_before_use > 0
						? `Move \`await parent()\` down to just before line ${u.first_use}, where ${names} is first used: the calls above it then run while the layout's load does.`
						: "Move the await parent() below the page's own fetches (start them first, await parent() after), or pass what the page needs some other way — the two loads then overlap.",
				...(u ? { file: c.page, line: u.line } : {})
			}
		);
	}
	for (const l of tl?.lanes ?? []) {
		if (l.kind === 'universal' && l.wait_ms >= 5) {
			info(
				'universal-load',
				`${l.file} is a universal load: on this render it waited ${fmt_ms(l.wait_ms)} ms on calls. On a page with the client router it runs again in the browser on every navigation, and its data must be serializable.`,
				{
					fix:
						'If it only needs the server (a database, a secret, a private API), rename it +' +
						l.level +
						'.server.ts and the browser never runs it.'
				}
			);
		}
	}
	// KIT'S COPY OF THE SERVER LOAD DATA: Kit `devalue.uneval`s each server load result as it
	// arrives (page/data_serializer.js `add_node`) — on EVERY page. A csr=true page puts it in the
	// HTML for the client router; a csr=false page never reads it (render.js uses it only with csr):
	// built on every request, dropped. Measured on a 250 KB load: about a third of the server's CPU.
	// (anchored on devalue's heaviest function: uneval's own frame holds little — its inner walk and
	// stringify do the work)
	const uneval = a.functions.filter((f) => f.pkg === 'devalue').sort((x, y) => y.self_ms - x.self_ms);
	const kit_ms = kit_load_serialize_ms(a);
	const runs = meta.trigger === 'page' ? Math.max(meta.runs?.length ?? 1, 1) : 1;
	if (uneval.length && kit_ms >= 3 && kit_ms >= a.busy_ms * 0.03) {
		// (the profiled render went through ogygia's csr=false path: its request carries ogygia's stats)
		const csr_false = meta.requests.some((r) => r.internal && r.og);
		info(
			'kit-uneval',
			csr_false
				? `Kit serialized this page's server load data: ${fmt_ms(kit_ms / runs)} ms per render (devalue.uneval). On a csr=false page nothing reads that copy — Kit builds it on every request and drops it.`
				: `Kit serialized the load data for its client router: ${fmt_ms(kit_ms / runs)} ms per render (devalue.uneval). This page has csr on.`,
			{
				anchor: `fn:${uneval[0].key}`,
				fix: csr_false
					? 'Only less load data helps: return from the server loads (+page.server.ts, +layout.server.ts) only what this page renders. Islands get what they read from ogygia’s own seed, shaped apart from it. The work is Kit’s, not yours.'
					: 'Return from the server load only what the page renders: Kit serializes all of it into the HTML for its client router. (csr=false does not make it free — Kit still builds the copy and drops it — so less data is the fix either way.)'
			}
		);
	}
	// {#each} HOT LISTS and MARKUP-HEAVY components: the parent that renders the rows, and whether a
	// component's time is its template or its script.
	const busy = a.busy_ms || 1;
	// `calls` comes from ONE coverage render (per render already); total_ms spans every run
	const list = a.components.find(
		(c) => (c.calls ?? 0) >= 20 && c.parent && c.total_ms >= busy * 0.1
	);
	if (list) {
		const n = list.calls ?? 0;
		info(
			'hot-list',
			`${list.parent} renders ${n} ${list.name} rows per render, ${fmt_ms(list.total_ms / runs)} ms together (${fmt_ms(list.total_ms / runs / Math.max(n, 1))} ms each).`,
			{
				anchor: `comp:${list.parent}`,
				fix: 'The list is the cost, not the row: page it, window it, or defer the part below the fold into a hole.'
			}
		);
	}
	const split = a.components.find(
		(c) =>
			(c.markup_ms ?? 0) + (c.logic_ms ?? 0) >= busy * 0.15 &&
			(c.markup_ms ?? 0) + (c.logic_ms ?? 0) >= 5
	);
	if (split) {
		// per render, like the rest (the split adds up every run)
		const m = (split.markup_ms ?? 0) / runs;
		const l = (split.logic_ms ?? 0) / runs;
		const own = m + l;
		if (m >= own * 0.7) {
			info(
				'markup-heavy',
				`${split.name}'s own time is mostly building markup: ${fmt_ms(m)} of ${fmt_ms(own)} ms is Svelte writing its template per render, ${fmt_ms(l)} ms its script.`,
				{
					anchor: `comp:${split.name}`,
					fix: 'Fewer elements and attributes per instance help here; the script is not the problem. Static blocks can move into a lake or a prebaked snippet.'
				}
			);
		} else if (l >= own * 0.7) {
			info(
				'logic-heavy',
				`${split.name}'s own time is mostly its script: ${fmt_ms(l)} of ${fmt_ms(own)} ms runs code per render, only ${fmt_ms(m)} ms writes markup.`,
				{
					anchor: `comp:${split.name}`,
					fix: 'Open the row: the hot function under it is the one to hoist into load or cache per request.'
				}
			);
		}
	}
}

/** Cold vs warm per file: what the first render paid over a warm one (module load + compile). */
export function cold_rows(
	a: Analysis,
	meta: ReportMeta
): {
	file: string;
	category: import('./analyze.js').FrameCategory;
	cold_ms: number;
	warm_ms: number;
	extra_ms: number;
}[] {
	if (!meta.cold) return [];
	const runs = runs_of(meta);
	const warm = new Map(a.files.map((f) => [f.key, f.self_ms / runs]));
	return meta.cold.files
		.map((f) => {
			const w = warm.get(f.file) ?? 0;
			return {
				file: f.file,
				category: f.category,
				cold_ms: f.ms,
				warm_ms: round1(w),
				extra_ms: round1(f.ms - w)
			};
		})
		.filter((r) => r.extra_ms >= 0.5)
		.sort((x, y) => y.extra_ms - x.extra_ms);
}

/** The spread of a component across runs: median of the rest against the max, and the cold first run. */
export function run_spread(runs_ms: number[]): {
	min: number;
	median: number;
	max: number;
	max_run: number;
	after: number;
	cold: boolean;
} | null {
	if (runs_ms.length < 2) return null;
	const sorted = [...runs_ms].sort((x, y) => x - y);
	const median = sorted[Math.floor(sorted.length / 2)];
	const max = sorted[sorted.length - 1];
	const rest = runs_ms.slice(1);
	const rest_median = [...rest].sort((x, y) => x - y)[Math.floor(rest.length / 2)];
	return {
		min: sorted[0],
		median,
		max,
		max_run: runs_ms.indexOf(max) + 1,
		/** the median of every run after the first: what "warm" costs */
		after: rest_median,
		// the first run alone is the outlier: a cache that was cold, a lazy import
		cold: runs_ms[0] >= 5 && runs_ms[0] >= rest_median * 2.5 && max === runs_ms[0]
	};
}

/** Do the runs climb? The page getting slower render by render — what a page that keeps memory, or
 *  a cache that grows without a bound, does to an instance as it ages. The slope is the median of
 *  every pair's slope (one slow run cannot tilt it), and it counts only when most pairs agree: at
 *  least 3 of 4 later runs slower than an earlier one. A cold first run is left out (that is the
 *  cold start, not a climb). Needs 4 runs; null when the runs do not climb. */
export function run_trend(runs_ms: readonly number[]): {
	from: number;
	to: number;
	slope_ms: number;
	rise_ms: number;
	rise_pct: number;
	agree: number;
	runs: number;
} | null {
	let r = runs_ms;
	if (r.length >= 5 && run_spread([...r])?.cold) r = r.slice(1);
	const n = r.length;
	if (n < 4) return null;
	const slopes: number[] = [];
	let up = 0;
	let pairs = 0;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			slopes.push((r[j] - r[i]) / (j - i));
			if (r[j] > r[i]) up++;
			pairs++;
		}
	}
	slopes.sort((x, y) => x - y);
	const slope = slopes[Math.floor(slopes.length / 2)];
	const agree = up / pairs;
	const base = Math.min(r[0], r[1]);
	const rise = slope * (n - 1);
	if (slope <= 0 || agree < 0.75 || base <= 0 || rise < Math.max(3, base * 0.05)) return null;
	return {
		from: round1(r[0]),
		to: round1(r[n - 1]),
		slope_ms: round1(slope),
		rise_ms: round1(rise),
		rise_pct: Math.round((rise / base) * 100),
		agree: Math.round(agree * 100) / 100,
		runs: n
	};
}

/** Findings from the accuracy round: the upstream's own split of a wait, the cold render, a
 *  component whose runs disagree, and the browser's vitals against the server's render. */
function accuracy_findings(
	a: Analysis,
	meta: ReportMeta,
	extras: ReportExtras,
	info: Say,
	warn: Say
): void {
	const runs = runs_of(meta);
	// UPSTREAM SPLIT: the slowest call that told us, through Server-Timing, where ITS time went.
	const told = extras.net
		.filter((c) => c.ms >= 0 && c.timings?.length)
		.sort((x, y) => y.ms + (y.body_ms ?? 0) - (x.ms + (x.body_ms ?? 0)))[0];
	if (told && told.ms >= 20) {
		// Server-Timing entries often NEST (a framework's `render 30` holds `db 21` and `tpl 6`), and
		// then their sum counts the same time twice: past the wait itself, the largest entry is the
		// honest total of their side; the side can never be more than the wait
		const sum = told.timings!.reduce((s, t) => s + t.ms, 0);
		const largest = Math.max(0, ...told.timings!.map((t) => t.ms));
		const nested = sum > told.ms;
		const theirs = Math.min(told.ms, nested ? largest : sum);
		const parts = told
			.timings!.filter((t) => t.ms > 0)
			.sort((x, y) => y.ms - x.ms)
			.slice(0, 4)
			.map((t) => `${t.desc ?? t.name} ${fmt_ms(t.ms)} ms`)
			.join(', ');
		const { host, tpl } = path_template(told.url);
		info(
			'upstream-split',
			`${told.method} ${host}${tpl} waited ${fmt_ms(told.ms)} ms; its own Server-Timing says ${parts || 'nothing measurable'}` +
				(theirs > 0
					? ` — ${fmt_ms(theirs)} ms of the wait is on their side${nested ? ' (the entries overlap, so the largest is taken as the whole)' : ''}, ${fmt_ms(Math.max(0, told.ms - theirs))} ms is the network and their framework.`
					: '.'),
			{
				fix:
					theirs >= told.ms * 0.6
						? 'The wait is theirs: take the biggest entry to whoever owns that service, or cache the response.'
						: 'Most of the wait is outside their measured work: the network path, TLS, or a queue in front of them.'
			}
		);
	}
	// COLD START: the first render against the warm ones, and which files paid for it.
	if (meta.cold && meta.runs?.length) {
		const warm = [...meta.runs].sort((x, y) => x - y)[Math.floor(meta.runs.length / 2)];
		const rows = cold_rows(a, meta);
		const extra = rows.reduce((s, r) => s + r.extra_ms, 0);
		// BY PART OF THE RENDER: each owner (the drill-down's rows) cold against its warm median —
		// which work got slower, not only which file's code ran
		const parts = (meta.cold.owners ?? [])
			.map((o) => {
				const w = a.owner_runs_ms?.[o.label];
				const med = w?.length ? [...w].sort((x, y) => x - y)[Math.floor(w.length / 2)] : 0;
				return { label: o.label, extra: o.ms - med };
			})
			.filter((o) => o.extra >= 5)
			.sort((x, y) => y.extra - x.extra)
			.slice(0, 3);
		const by_part = parts.length
			? `; by part of the render: ${parts.map((o) => `${o.label} +${fmt_ms(o.extra)} ms`).join(', ')}`
			: '';
		if (meta.cold.ms >= warm * 1.5 && meta.cold.ms - warm >= 50) {
			// the extra wall is CPU (module load, compile, first-call caches) AND waiting: the first
			// render's connections are new (DNS, TLS, an empty pool), which no file's CPU shows
			const more = meta.cold.ms - warm;
			const cpu_more = Math.min(more, Math.max(0, meta.cold.busy_ms - a.busy_ms / runs));
			const wait_more = more - cpu_more;
			// no outbound call in the cold render: its extra waiting is not the network (a page with
			// none once read "its connections were new: DNS, TLS") — it is the first loads of what the
			// render reads (a dynamic import, a file), which CPU samples do not show
			const calls = meta.cold.calls;
			const waiting =
				calls === 0
					? `, and ${fmt_ms(wait_more)} ms more waiting with no outbound call in that render: not the network, but the first loads of the modules and files it reads (a dynamic import, a file read), which CPU samples do not show`
					: `, and ${fmt_ms(wait_more)} ms more waiting (${calls ? `its ${calls} outbound call${calls === 1 ? '' : 's'} opened new connections` : 'its connections were new'}: DNS, TLS, empty pools)`;
			warn(
				'cold-start',
				`The first render took ${fmt_ms(meta.cold.ms)} ms against ${fmt_ms(warm)} ms warm: ${fmt_ms(cpu_more)} ms more CPU (module load, compile, first-call caches)` +
					(rows[0]
						? `, ${share_word(rows[0].extra_ms, cpu_more)} ${rows[0].file} (${fmt_ms(rows[0].extra_ms)} ms)`
						: '') +
					by_part +
					(wait_more >= 10 ? waiting : '') +
					'. On a serverless host every cold instance pays this.',
				{
					fix:
						wait_more > cpu_more && calls !== 0
							?'Most of it is the first calls opening their connections: reuse one HTTP agent or client across requests (module scope, keep-alive on), and keep calls to services that are slow to connect out of the first render where you can.'
							: 'Fewer and smaller server modules on the page’s path: lazy-import what the render rarely needs, keep heavy libraries out of hooks and layouts, and prefer a warm instance (provisioned concurrency) where the platform offers one.'
				}
			);
		} else if (rows.length && extra >= 20) {
			info(
				'cold-start',
				`The first render paid ${fmt_ms(extra)} ms of module load and compile over a warm one, ${share_word(rows[0].extra_ms, extra)} ${rows[0].file} (${fmt_ms(rows[0].extra_ms)} ms)${by_part}.`
			);
		}
	}
	// THE INSTANCE'S OWN START: on AWS Lambda an instance starts for a request, so the time from its
	// process starting to its first request is the cold start before any render (on a long-running
	// server that time is mostly waiting for traffic, and says nothing)
	const inst = meta.instance;
	if (meta.lambda && inst && inst.first_request_ms >= 100) {
		const first_render =
			meta.cold && meta.runs?.length
				? meta.cold.ms - [...meta.runs].sort((x, y) => x - y)[Math.floor(meta.runs.length / 2)]
				: 0;
		info(
			'cold-instance',
			`This instance took ${fmt_ms(inst.first_request_ms)} ms from its process starting to its first request: Node's own startup ${fmt_ms(inst.node_ms)} ms, the rest loading the server bundle and its imports and the platform handing the request over. Every new instance on AWS Lambda pays that before its first render` +
				(first_render >= 20
					? `, and the first render then pays about ${fmt_ms(first_render)} ms more to warm up`
					: '') +
				`. This one was ${inst.age_s} s old and had served ${inst.requests_before} request${inst.requests_before === 1 ? '' : 's'} before this recording.`,
			{
				fix: 'Load less at startup: import heavy SDKs where a page needs them (a dynamic import inside the load or the handler), keep them out of hooks.server and root layouts, and use provisioned concurrency where the first visitor after a quiet spell matters.'
			}
		);
	}
	// THE CLIMB: every render slower than the last. Its likely cause, when this report caught one, is
	// what a render leaves alive; either way the median below is a snapshot of an instance still aging.
	const climb = meta.trigger === 'page' && meta.runs ? run_trend(meta.runs) : null;
	if (climb) {
		const kept =
			extras.retained && extras.retained.total_bytes >= 256 * 1024 ? extras.retained : undefined;
		const g = extras.growth;
		const why = kept
			? ` One render leaves ${Math.round((kept.total_bytes / 1048576) * 10) / 10} MB alive after a full collection${g ? (g.levels_off ? ', and it levels off, so the climb should stop once that cache is full' : ', and it keeps growing, so the climb will not stop') : ''}: the bigger heap makes every collection, and every lookup in what is kept, cost more.`
			: ' Nothing this report measured was left alive by a render, so look for a list, map or cache the page adds to on every request (a memo keyed by something new each time), or a timer or listener it registers again each render.';
		warn(
			'slower-each-run',
			`Each render took about ${fmt_ms(climb.slope_ms)} ms longer than the one before: ${fmt_ms(climb.from)} ms → ${fmt_ms(climb.to)} ms over ${climb.runs} runs (+${climb.rise_pct}%).${why} On a long-lived server this keeps climbing until the instance restarts, and the times in this report sit somewhere along the way.`,
			{
				fix: kept
					? 'Bound or release what a render keeps (the Kept per render pattern names the line), then profile again: the runs should come out flat.'
					: 'Profile again with more renders: if the climb holds, find what grows per request; if it flattens, it was a cache warming.',
				...(kept?.sites[0]?.url ? { file: kept.sites[0].url, line: kept.sites[0].line } : {})
			}
		);
	}
	// A HEAP EARLIER REQUESTS FILLED: the page keeps memory alive every render, and this profile
	// started on a heap already holding many renders' worth of it. Every render here pays for a heap
	// it did not make, and each render's runs are flat, so nothing above says so: /hell read 720 ms on
	// a fresh server and 1 310 ms two profiles later, with the same code
	const heap0 = extras.mem[0]?.heap_used;
	const kept_each = extras.retained?.total_bytes ?? 0;
	if (
		meta.trigger === 'page' &&
		heap0 !== undefined &&
		heap0 >= 256 &&
		kept_each >= 8 * 1048576 &&
		!extras.growth?.levels_off
	) {
		const kept_mb = kept_each / 1048576;
		const worth = Math.round(heap0 / kept_mb);
		if (worth >= 6)
			warn(
				'heap-filled-before',
				`This profile started with ${Math.round(heap0)} MB of heap in use: about ${worth} renders' worth of what this page keeps alive (${Math.round(kept_mb * 10) / 10} MB each), left by earlier requests. A bigger heap makes every render slower, so the times here are higher than a freshly started server shows, and the next profile will read higher still.`,
				{
					fix: 'Fix what a render keeps (the Kept per render pattern names the line). Until then, compare numbers from freshly started servers only: restart, then profile once.'
				}
			);
	}
	// RUN VARIANCE: a component whose runs disagree is a cache, not a slow render.
	if (runs > 1) {
		const spread = a.components
			.map((c) => ({ c, s: c.runs_ms ? run_spread(c.runs_ms) : null }))
			.filter(
				(
					x
				): x is {
					c: (typeof a.components)[number];
					s: NonNullable<ReturnType<typeof run_spread>>;
				} => !!x.s && x.s.max >= 5
			)
			.sort((x, y) => y.s.max - y.s.median - (x.s.max - x.s.median))[0];
		if (spread && spread.s.cold) {
			info(
				'component-cold-run',
				`${spread.c.name} took ${fmt_ms(spread.s.max)} ms in the first render and ${fmt_ms(spread.s.after)} ms after: a cache that was cold, or a lazy import — not a slow component.`,
				{
					anchor: `comp:${spread.c.name}`,
					fix: 'Warm it at startup, or accept it: only the first request after a deploy pays this.'
				}
			);
		} else if (
			spread &&
			spread.s.max >= spread.s.median * 3 &&
			spread.s.max - spread.s.median >= 10
		) {
			warn(
				'component-variance',
				`${spread.c.name} is ${fmt_ms(spread.s.median)} ms in most renders but ${fmt_ms(spread.s.max)} ms in run ${spread.s.max_run}: something it waits on or caches is not steady.`,
				{
					anchor: `comp:${spread.c.name}`,
					fix: 'Open the row: the per-run column shows the spread; a cache with a short TTL, a GC pause, or a shared upstream are the usual causes.'
				}
			);
		}
	}
	// THE APP'S OWN BROWSER MARKS: the slowest one, next to the server's render.
	const marks = extras.client_marks ?? [];
	if (marks.length) {
		const slow = [...marks].sort((x, y) => y.p50_ms - x.p50_ms)[0];
		const failed = marks.filter((m) => m.errors > 0);
		info(
			'client-mark',
			`In the browser the app marked ${marks.length} thing${marks.length === 1 ? '' : 's'}: the slowest is ${slow.name} at ${fmt_ms(slow.p50_ms)} ms (p50 of ${slow.n})` +
				(failed.length ? `; ${failed.map((m) => m.name).join(', ')} failed.` : '.'),
			{
				fix:
					slow.p50_ms >= 300
						? `${slow.name} is a wait the visitor feels after the HTML arrived: it is not the server render, take it to whatever ${slow.name} times.`
						: undefined
			}
		);
	}
	// THE BROWSER: vitals against the server's render — where the user's time really went.
	const v = extras.vitals;
	if (v && v.lcp !== null) {
		const server = meta.runs?.length
			? [...meta.runs].sort((x, y) => x - y)[Math.floor(meta.runs.length / 2)]
			: (meta.request?.ms ?? 0);
		const ttfb = v.ttfb ?? 0;
		if (v.lcp - ttfb >= Math.max(500, ttfb) && server > 0) {
			// (the report's own visit: a text paint that waited for a hidden font names that font;
			// else the LCP's own split, when one part after the first byte is most of the wait)
			const own = extras.visit;
			const font = lcp_font(own);
			const parts = own?.paints?.lcp_url
				? vital_parts({ vitals: {}, visit: { nav: own.nav, paints: own.paints, resources: own.resources }, islands: [], firsts: [], shifts: [], longtasks: [] }, 'lcp')
				: null;
			const after = parts?.filter((x) => x.key !== 'ttfb') ?? [];
			const top = after.length ? after.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
			const gap = (own?.paints?.lcp ?? v.lcp) - ttfb;
			const lcp_file = own?.paints?.lcp_url ? own.paints.lcp_url.slice(own.paints.lcp_url.lastIndexOf('/') + 1).split('?')[0] : '';
			const part = !font && top && top.ms >= gap / 2 ? top : null;
			const PART_WORDS: Record<string, [string, string]> = {
				delay: [
					`most of it (${fmt_ms(part?.ms ?? 0)} ms) before the browser began fetching the largest paint, ${lcp_file}.`,
					'The browser found the largest paint late: put it in the HTML as an `<img>` (not a CSS background or a script-added one), never `loading="lazy"`, and preload it with `fetchpriority="high"`.'
				],
				load: [
					`most of it (${fmt_ms(part?.ms ?? 0)} ms) downloading the largest paint, ${lcp_file}.`,
					'The largest paint is slow to download: make it smaller (a modern format, sized to how it shows, `srcset`) and serve it from close by. The server is not the bottleneck here.'
				],
				render: [
					`most of it (${fmt_ms(part?.ms ?? 0)} ms) after the largest paint, ${lcp_file}, had arrived: something held its paint.`,
					'The largest paint was ready but did not paint: render-blocking styles or scripts, or an island that shows it on waking. Render it with the server HTML.'
				]
			};
			const words = part ? PART_WORDS[part.key] : undefined;
			// (a download, a late start or a font wait that shared the network with images nobody saw yet)
			const rivals = font || part?.key === 'load' || part?.key === 'delay' ? lcp_rivals(own) : null;
			warn(
				'lcp-gap',
				`In the browser LCP is ${fmt_ms(v.lcp)} ms while the server answered in ${fmt_ms(ttfb)} ms (TTFB; the render itself ${fmt_ms(server)} ms): ${fmt_ms(v.lcp - ttfb)} ms of the user's wait is after the HTML arrived — ` +
					(font
						? `the largest paint is text that waited for its font '${font.family}' (${font.file}, in at ${fmt_ms(font.end)} ms), invisible until it came.`
						: words
							? words[0]
							: 'assets, fonts, hydration.') +
					(rivals ? ` Beside it, ${fmt_bytes(rivals.bytes)} of images far below the first screen downloaded (${rivals.files.join(', ')}).` : ''),
				{
					fix:
						(font
							? "Give the font's @font-face `font-display: swap` (or `optional`) and preload the file: the text paints with the HTML, and the server is not the bottleneck here."
							: words
								? words[1]
								: 'Make the hero markup static (a lake), preload its image and font, and keep the islands above the fold small: the server is not the bottleneck here.') +
						(rivals ? ' And give the images below the first screen `loading="lazy"`: they took a share of the network the largest paint needed.' : '')
				}
			);
		} else if (ttfb > 0 && ttfb >= server * 2 && ttfb - server >= 200) {
			// THE GAP, SPLIT (the report's own visit): the browser's steps before the request left, then
			// the request until the first byte — of which the server's handler held so much (the request
			// log), the render within it; what is left of the wait was before the handler took it
			const own = extras.visit?.nav;
			const ph = own?.phases;
			const held = extras.doc_request?.ms;
			let split = '';
			let where: 'connect' | 'before' | 'inside' | null = null;
			if (ph && held !== undefined) {
				const connect = (ph.redirect ?? 0) + (ph.worker ?? 0) + (ph.dns ?? 0) + (ph.connect ?? 0) + (ph.tls ?? 0);
				const before = Math.max(0, (ph.wait ?? 0) - held);
				const inside = Math.max(0, held - server);
				where = connect >= before && connect >= inside ? 'connect' : before >= inside ? 'before' : 'inside';
				split = ` In the report's own visit (TTFB ${fmt_ms(own!.res_start)} ms): ${fmt_ms(connect)} ms redirecting and connecting, ${fmt_ms(before)} ms before the server's handler took the request, and ${fmt_ms(inside)} ms inside the handler beyond the render.`;
			}
			warn(
				'ttfb-gap',
				`TTFB in the browser is ${fmt_ms(ttfb)} ms but this server rendered the page in ${fmt_ms(server)} ms: ${fmt_ms(ttfb - server)} ms sits between the two${where ? '.' : ' — a cold instance, a proxy, or the network.'}${split}`,
				{
					fix:
						where === 'connect'
							? 'The connection is the cost: redirects to drop, or a server far from the visitor (serve it from the edge, keep TLS and HTTP modern).'
							: where === 'before'
								? 'The request waited before this server took it: a proxy or CDN in front, a cold instance starting, or the network. Look at what fronts the server, and at the cold-start section.'
								: where === 'inside'
									? meta.dev
										? "The server held the request past its render: on the dev server a first request compiles the page (profile a build for its real TTFB), or a hook before the render awaits something."
										: 'The server held the request past its render: a hook before or after the render (auth, a session lookup, a redirect check) awaits something. Profile it with the handle, not only the page.'
									: 'Look at the cold-start section and at what fronts the server (a CDN, an auth proxy): the render is not where that time goes.'
				}
			);
		} else {
			info(
				'browser-vitals',
				`The browser measured TTFB ${v.ttfb === null ? '—' : fmt_ms(v.ttfb) + ' ms'}, LCP ${fmt_ms(v.lcp)} ms${v.cls !== null ? `, CLS ${v.cls}` : ''}${v.inp !== null ? `, INP ${fmt_ms(v.inp)} ms` : ''} over ${v.n} visit${v.n === 1 ? '' : 's'}.`
			);
		}
	}
}

/**
 * The whole profile as one curated JSON object — the agent-facing view. Served
 * at `<base>/report/<id>.json`. Not the raw V8 profile (that is `/raw`): this is
 * already analyzed — self/total per component, network attribution, memory, GC,
 * and the same findings the human report shows.
 */
/** One stack frame as agents read it: `name (file:line)`. */
const frame_text = (fr: { n: string; f: string }): string => (fr.f ? `${fr.n} (${fr.f})` : fr.n);

/** Gather the ogygia signals a page score reads — the same numbers the findings above compute, so
 *  the score and the findings never disagree. All safe when a signal is absent (no visits, no server
 *  timing). See {@link page_score}. */
export function page_score_of(meta: ReportMeta, extras: ReportExtras): PageScore {
	const islands = group_islands(island_rows_of(meta));
	// (JS is the WHOLE page's now — every script at start, islands or not: `extras.assets`. The old
	// island-only sum read "0 JS" on a page with no islands however much it shipped.)

	const og = [...meta.requests]
		.filter((r) => r.og)
		.sort(
			(x, y) => y.og!.seed_bytes + y.og!.tail_bytes - (x.og!.seed_bytes + x.og!.tail_bytes)
		)[0]?.og;

	const client = extras.client ?? [];
	const seen_entry = new Set(client.map((c) => c.entry));

	const server_ms = meta.runs?.length
		? [...meta.runs].sort((x, y) => x - y)[Math.floor(meta.runs.length / 2)]
		: (meta.request?.ms ?? null);

	const v = extras.vitals;
	const visit = extras.visit;
	// the whole page's weight: every file at start (islands or not), from page-assets.ts
	const pa = extras.assets;
	// (with the scripts other scripts loaded at runtime, as the browser measured: start_js)
	const sj = start_js(extras);
	const assets: ScoreAssets | null = pa
		? {
				js: sj!.js,
				js_wire: sj!.js_wire,
				js_files: sj!.js_files,
				lazy_js: Math.max(0, pa.totals.lazy_js - (sj!.woke_early?.bytes ?? 0)),
				css: pa.totals.css,
				wire: pa.totals.wire + (sj!.runtime?.wire ?? 0),
				blocking: pa.totals.blocking,
				blocking_count: pa.totals.blocking_count,
				top: pa.assets
					.filter((x) => x.kind === 'script' && !x.lazy)
					.slice(0, 4)
					.map((x) => `${asset_name(x.url)} ${fmt_bytes(x.bytes)}${x.contains?.length ? ` (${x.contains.slice(0, 3).join(', ')})` : ''}`)
					.concat(sj!.runtime ? [`loaded at runtime by other scripts ${fmt_bytes(sj!.runtime.bytes)} (${sj!.runtime.by[0].who})`] : [])
			}
		: null;
	// data shipped for hydration: the seeds, the props tail, the inline script text
	const inline_script = extras.strip?.by_kind.script ?? pa?.inline.script ?? 0;
	const data_parts: [string, number][] = [
		['page seed', og?.seed_bytes ?? 0],
		['island props', og?.tail_bytes ?? 0],
		['remote seed', og?.remote_seed_bytes ?? 0],
		['inline script', inline_script]
	];
	const data_bytes = data_parts.reduce((s, [, b]) => s + b, 0);
	// total blocking time over the visit's long tasks (the Lighthouse definition: past 50 ms each)
	// (a browser that cannot observe long tasks — Safari — reported none: that is unknown, not zero;
	// the same for layout shifts and CLS)
	const no_longtasks = !!visit?.unsupported?.includes('longtask');
	const no_shifts = !!visit?.unsupported?.includes('layout-shift');
	const tbt = no_longtasks ? null : visit?.longtasks?.length ? Math.round(visit.longtasks.reduce((s, t) => s + Math.max(0, t.ms - 50), 0)) : visit ? 0 : null;
	const unmeasured: ScoreInputs['unmeasured'] = {
		...(no_longtasks ? { tbt: 'the browser that visited does not report long tasks (Safari, for one): profile the page from a Chromium browser to measure it' } : {}),
		...(no_shifts ? { cls: 'the browser that visited does not report layout shifts (Safari, for one): profile the page from a Chromium browser to measure it' } : {})
	};
	const inputs: ScoreInputs = {
		assets,
		...(extras.assets_missing ? { assets_missing: extras.assets_missing } : {}),
		htmlBytes: extras.strip?.total ?? pa?.html.bytes ?? null,
		// the bytes the browser fetched for nothing: pixels past what each box shows, preloads nothing used
		...(() => {
			const img = (visit?.images_oversized ?? []).reduce((s, i) => s + i.bytes * Math.max(0, 1 - (i.shown[0] * i.shown[1] * i.dpr * i.dpr) / (i.natural[0] * i.natural[1])), 0);
			const pre = (visit?.preloads_unused ?? []).reduce((s, p) => s + p.bytes, 0);
			return img + pre >= 10 * 1024 ? { wasted: { bytes: Math.round(img + pre), images: Math.round(img), preloads: pre } } : {};
		})(),
		hasIslands: islands.length > 0,
		browserSeen: client.length > 0 || !!visit,
		recovered: client.reduce((s, c) => s + c.recovered, 0),
		// only meaningful once the beacon has reported at all — no visits, no "never woke"
		neverWoke: client.length
			? islands.filter(
					(r) =>
						(r.wake === 'load' || r.wake === 'idle' || r.wake === 'visible') &&
						!seen_entry.has(r.entry)
				).length
			: 0,
		changed: visit?.islands?.filter((i) => i.changed && !i.recovered).length ?? 0,
		dataBytes: data_bytes,
		dataDetail: data_parts.filter(([, b]) => b > 0).map(([k, b]) => `${k} ${fmt_bytes(b)}`),
		serverMs: server_ms,
		// the vitals beacon goes out when the page hides; the visit (sent early too) carries the
		// same paints, so a visit whose vitals never arrived still scores its loading
		vitals: v
			? { lcp: v.lcp, cls: v.cls, inp: v.inp, fcp: v.fcp, ttfb: v.ttfb }
			: visit
				? {
						lcp: visit.paints?.lcp ?? null,
						fcp: visit.paints?.fcp ?? null,
						ttfb: visit.nav?.res_start ?? null,
						cls: no_shifts ? null : visit.shifts?.length ? Math.round(visit.shifts.reduce((s, x) => s + x.value, 0) * 1000) / 1000 : 0,
						inp: null
					}
				: null,
		tbt,
		unmeasured
	};
	return page_score(inputs);
}

export function report_json(a: Analysis, meta: ReportMeta, base: string, extras: ReportExtras) {
	const dur = a.duration_ms || 1;
	const busy = a.busy_ms || 1;
	const net = extras.net.filter((c) => c.ms >= 0);
	const net_total = round1(net.reduce((s, c) => s + c.ms + (c.body_ms ?? 0), 0));

	const budget = a.buckets
		.filter((b) => b.self_ms > 0 && b.category !== 'idle')
		.map((b) => ({
			label: b.key,
			category: b.category,
			ms: b.self_ms,
			pct: round1((b.self_ms / dur) * 100)
		}));
	if (a.idle_ms > 0)
		budget.push({
			label: 'idle / waiting',
			category: 'idle',
			ms: a.idle_ms,
			pct: round1((a.idle_ms / dur) * 100)
		});
	budget.sort((x, y) => y.ms - x.ms);

	// a component's bytes: everything allocated under it (heap_components), else the function join
	const alloc_by_name = new Map<string, number>();
	for (const h of extras.heap ?? [])
		alloc_by_name.set(h.name, (alloc_by_name.get(h.name) ?? 0) + h.self_bytes);
	for (const c of extras.heap_components ?? []) alloc_by_name.set(c.name, c.bytes);

	const verdict =
		a.idle_ms > dur * 0.5 ? 'waiting' : (a.busy_ms / dur) * 100 > 60 ? 'compute-bound' : 'mixed';
	const hosts = top_hosts(net);

	return {
		schema: 'ogygia-profiler-report',
		version: 1,
		units: { time: 'ms', size: 'bytes', memory_suffix_mb: true },
		id: meta.id,
		created: meta.created,
		kind: meta.trigger,
		node: meta.node,
		dev: !!meta.dev,
		sourcemapped: a.sourcemapped,
		...(a.other_requests_ms ? { other_requests_ms: a.other_requests_ms } : {}),
		target: {
			page: meta.page ?? null,
			redirected_from: meta.redirected_from ?? null,
			runs: meta.runs ?? null,
			warmup_ms: meta.warmup_ms ?? null,
			run_status: meta.run_status ?? null,
			run_bytes: meta.run_bytes ?? null,
			budget_note: meta.budget_note ?? null,
			// what the clock said per run, before the profiler's own share was taken out of `runs`
			runs_measured: meta.runs_measured ?? null,
			// the instance it ran on (its start to first request, age, requests before this one)
			instance: meta.instance ?? null,
			lambda: meta.lambda ?? false,
			request: meta.request ?? null
		},
		summary: {
			window_ms: meta.duration_ms,
			busy_ms: a.busy_ms,
			// the profiler's own cost, measured and kept out of every other number here, and what it was
			overhead: meta.overhead ? { ...meta.overhead, top: a.overhead_functions ?? [] } : null,
			busy_pct: round1((a.busy_ms / dur) * 100),
			idle_ms: a.idle_ms,
			// the observer's pauses with the profiler's share taken out when the attribution ran, else
			// the sampler's GC frames
			gc_ms: extras.gc_attr ? extras.gc_attr.summary.total_ms : a.gc_ms,
			gc_sampled_ms: a.gc_ms,
			verdict,
			sample_count: a.sample_count,
			cpu_percent: meta.cpu_percent ?? null,
			elu_percent: meta.elu_percent ?? null,
			loop_delay_ms: meta.loop_delay ?? null,
			rss_mb: meta.rss_mb ?? null
		},
		// ONE number for the page, ogygia's own — scored on least JS, clean hydration, small seed +
		// server render, stable layout (see score.ts). Sub-scores + the "fix this first" pick ride along.
		score: page_score_of(meta, extras),
		findings: derive_findings(a, meta, extras),
		budget,
		// ONE request's critical path: the ordered steps that set its wall time, the phases, and the
		// await chains that could overlap (page / request mode only).
		timeline: a.timeline
			? {
					window_ms: a.timeline.window_ms,
					cpu_ms: a.timeline.cpu_ms,
					wait_ms: a.timeline.wait_ms,
					unaccounted_ms: a.timeline.gap_ms,
					phases: a.timeline.phases.map((p) => ({
						phase: p.phase,
						label: PHASE_LABEL[p.phase],
						cpu_ms: p.cpu_ms,
						wait_ms: p.wait_ms
					})),
					steps: chain_steps(a.timeline).map((s) => ({
						at_ms: s.seg.t0,
						ms: s.ms,
						pct: round1(s.pct),
						kind: s.seg.kind,
						phase: s.seg.phase,
						what: s.seg.label,
						detail: s.seg.detail ?? null,
						file: s.seg.file || null,
						calls: s.seg.calls ?? null,
						within: s.seg.within ?? null
					})),
					parallelizable: a.timeline.parallelizable.map((g) => ({
						calls: g.calls,
						ms: g.ms,
						save_ms: g.save_ms
					})),
					// Kit's load functions, one lane each, and the parent() chain when the page's load
					// sat behind the layout's
					lanes: (a.timeline.lanes ?? []).map((l) => ({
						file: l.file,
						level: l.level,
						kind: l.kind,
						t0_ms: l.t0,
						t1_ms: l.t1,
						cpu_ms: l.cpu_ms,
						wait_ms: l.wait_ms,
						awaited_parent: l.awaited_parent
					})),
					chain: a.timeline.chain ?? null,
					// which call waited for which: the serialized starts with their await sites
					awaits: a.timeline.awaits?.edges ?? []
				}
			: null,
		// the app's own spans (`span()`), per name: count, total, p50, max, errors, cache tallies, callers
		spans: span_rows(extras.spans),
		// hot functions that share one caller: the paths to fix, each with its call tree
		paths: (a.paths ?? []).map((g) => ({
			owner: {
				name: g.owner.name,
				file: g.owner.url,
				line: g.owner.line,
				category: g.owner.category,
				total_ms: g.owner.total_ms,
				calls: g.owner.calls ?? null
			},
			ms: g.ms,
			pct_busy: round1((g.ms / busy) * 100),
			share_of_owner: g.share,
			functions: g.fns.map((f) => ({
				name: f.name,
				file: f.url,
				line: f.line,
				category: f.category,
				package: f.pkg ?? null,
				ms: f.ms
			})),
			tree: g.tree
		})),
		ogygia: (() => {
			const og =
				[...meta.requests]
					.filter((r) => r.og)
					.sort(
						(x, y) => y.og!.seed_bytes + y.og!.tail_bytes - (x.og!.seed_bytes + x.og!.tail_bytes)
					)[0]?.og ?? null;
			if (!og) return null;
			const { island_rows, seed, hole_rows, ...totals } = og;
			const client = new Map((extras.client ?? []).map((c) => [c.entry, c]));
			const by_name = new Map(a.components.map((c) => [c.name, c]));
			let js_only: Map<string, number> | null = null;
			return {
				// the totals (`islands` / `holes` are COUNTS here; the rows follow)
				...totals,
				// one row per island (fingerprints merged): what it ships, what it costs on the server
				// (its component's SSR time), what it weighs in the browser, and what the browser measured
				island_rows: group_islands(island_rows ?? []).map((r, _i, grouped) => {
					js_only ??= island_js_unique(grouped, extras.weights);
					const comp = by_name.get(island_name(r));
					const cl = client.get(r.entry);
					return {
						name: island_name(r),
						entry: r.entry,
						fp: r.fp,
						fingerprints: r.variants ?? 1,
						copies: r.count,
						wake: r.wake,
						ssr_ms: comp ? round1(comp.total_ms / runs_of(meta)) : null,
						props_bytes: r.props_bytes,
						canonical_bytes: r.canonical_bytes,
						json: r.json,
						devalue_culprit: r.culprit,
						seed_refs: r.refs,
						seed_ref_keys: r.ref_keys,
						js_bytes: island_js_bytes(r, extras.weights),
						// of that, what no other waking island uses (what dropping it would save)
						js_only_bytes: js_only?.get(r.entry) ?? null,
						modules: [r.module_url, ...r.hints].filter(Boolean),
						interactivity: r.interactivity,
						client: cl
							? {
									hydrations: cl.n,
									p50_ms: cl.p50_ms,
									max_ms: cl.max_ms,
									load_p50_ms: cl.load_p50_ms,
									recovered: cl.recovered,
									...(cl.reason ? { reason: cl.reason } : {})
								}
							: null
					};
				}),
				// the seed explainer names islands already (hooks.ts explain_seed)
				seed: seed ?? null,
				hole_rows: (hole_rows ?? []).map((h) => {
					const e = hole_economics(meta).get(h.id);
					return {
						id: h.id,
						// the component and its props: what to look for in the code
						component: h.name || null,
						props: h.props || null,
						when: h.when,
						hydrate: h.hydrate,
						max_age_s: h.ttl,
						copies: h.count,
						requests: e
							? {
									hit: e.hit,
									miss: e.miss,
									uncached: e.none,
									avg_ms: round1(e.ms / Math.max(e.hit + e.miss + e.none, 1))
								}
							: null
					};
				})
			};
		})(),
		kit: {
			// the client router's serialization of load data (devalue.uneval under render_response)
			uneval_ms: round1(
				a.functions
					.filter((f) => f.pkg === 'devalue' && f.name === 'uneval')
					.reduce((s, f) => s + f.self_ms, 0)
			),
			etag_ms: round1(
				a.functions
					.filter((f) => f.name === 'hash' && f.pkg === '@sveltejs/kit')
					.reduce((s, f) => s + f.self_ms, 0)
			)
		},
		components: (() => {
			return [...a.components]
				.sort((x, y) => y.self_ms - x.self_ms)
				.map((c) => {
					const n = (c.calls ?? 0) || null;
					return {
						name: c.name,
						instances: n,
						file: c.url,
						path: c.path ?? null,
						line: c.line,
						column: c.col || null,
						self_ms: c.self_ms,
						total_ms: c.total_ms,
						// cost of a single render of it: its time per page render ÷ its renders in one (the
						// count is the coverage render's, the time adds up every run); null when unknown
						per_call_ms: per_call(c.total_ms / runs_of(meta), n),
						pct_busy: round1((c.total_ms / busy) * 100),
						alloc_bytes: alloc_by_name.get(c.name) ?? null,
						// its own time split: Svelte writing the template vs the script and what it calls
						markup_ms: c.markup_ms ?? null,
						logic_ms: c.logic_ms ?? null,
						// the component that rendered most of it (the {#each} owner of a row)
						parent: c.parent ?? null,
						// page mode: its inclusive ms in each run (the spread says cache miss vs slow code)
						runs_ms: c.runs_ms ?? null,
						// where inside it the self time landed
						hot_lines: c.lines ?? null,
						// the code around those lines (from the sourcemap's embedded copy on a deployed host)
						source: c.src ?? null,
						// what it called and how much of its time went into each (builtins, deps, app code)
						callees: c.callees ?? null,
						// the heaviest call paths that rendered it, nearest caller first
						stacks: (c.stacks ?? []).map((s) => ({ ms: s.ms, frames: s.frames.map(frame_text) }))
					};
				});
		})(),
		hot_functions: (() => {
			return a.functions.slice(0, 80).map((f) => {
				const n = (f.calls ?? 0) || null;
				return {
					name: f.name,
					// an anonymous function's own first line, where the name says nothing
					label: f.label ?? null,
					instances: n,
					file: f.url,
					path: f.path ?? null,
					line: f.line,
					column: f.col || null,
					category: f.category,
					package: f.pkg ?? null,
					self_ms: f.self_ms,
					total_ms: f.total_ms,
					per_call_ms: per_call(f.total_ms / runs_of(meta), n),
					// the heaviest call paths into it, nearest caller first
					stacks: (f.stacks ?? []).map((s) => ({ ms: s.ms, frames: s.frames.map(frame_text) })),
					// the hot lines inside it (source lines when a sourcemap resolved)
					hot_lines: f.lines ?? null,
					// the code around those lines (from the sourcemap's embedded copy on a deployed host)
					source: f.src ?? null,
					// what it called and how much of its time went into each (builtins, deps, app code)
					callees: f.callees ?? null
				};
			});
		})(),
		files: a.files
			.filter((f) => f.category !== 'idle')
			.slice(0, 40)
			.map((f) => ({
				file: f.key,
				category: f.category,
				self_ms: f.self_ms,
				pct_busy: round1((f.self_ms / busy) * 100)
			})),
		network: {
			count: net.length,
			total_ms: net_total,
			sequential_ms: sequential_ms(extras.net),
			errors: extras.net.filter((c) => c.error).length,
			hosts: hosts.map((h) => ({
				host: h.host,
				calls: h.count,
				total_ms: h.total,
				p50_ms: h.p50,
				max_ms: h.max,
				errors: h.errors
			})),
			calls: [...net]
				.sort((x, y) => y.ms + (y.body_ms ?? 0) - (x.ms + (x.body_ms ?? 0)))
				.slice(0, 200)
				.map((c) => ({
					method: c.method,
					url: c.url,
					host: c.host,
					status: c.status,
					wait_ms: c.ms,
					body_ms: c.body_ms ?? null,
					bytes: c.bytes ?? null,
					transfer_bytes: c.transfer_bytes ?? null,
					encoding: c.encoding ?? null,
					type: c.type ?? null,
					req_bytes: c.req_bytes ?? null,
					req_payload: c.req_payload ?? null,
					route: c.route ?? c.path ?? null,
					caller: c.caller ?? null,
					// the first-party call path above the caller, nearest first
					callers: c.callers ?? null,
					// what the upstream's own Server-Timing said the wait was spent on
					server_timing: c.timings ?? null,
					trace: c.trace ?? null,
					headers: c.headers ?? null,
					error: c.error ?? null
				}))
		},
		// the cold (warm-up) render against the warm ones, per file
		cold: meta.cold
			? { ms: meta.cold.ms, busy_ms: meta.cold.busy_ms, files: cold_rows(a, meta), ...(meta.cold.calls !== undefined ? { calls: meta.cold.calls } : {}) }
			: null,
		// the page's web vitals from the profiler user's own browser, the app's own marks there, and
		// the browser's CPU profile of hydration (components + functions, compact)
		browser:
			extras.vitals || extras.client_marks || extras.client_cpu || extras.visit
				? {
						...(extras.vitals ?? {}),
						...(extras.client_marks ? { marks: extras.client_marks } : {}),
						// the latest visit the beacon saw: navigation + paints + counts (the full lanes live in the report page)
						...(extras.visit
							? {
									visit: {
										at: extras.visit.at,
										nav: extras.visit.nav,
										paints: extras.visit.paints,
										// every file the page loaded (the totals, when the visit lists only the first 200)
										resources: extras.visit.resources_all ?? extras.visit.resources.length,
										resource_bytes: extras.visit.resource_totals
											? extras.visit.resource_totals.reduce((s, t) => s + t.transfer, 0)
											: extras.visit.resources.reduce((s, r) => s + (r.transfer ?? 0), 0),
										...(extras.visit.resource_totals ? { resource_totals: extras.visit.resource_totals } : {}),
										longtasks: extras.visit.longtasks.length,
										islands: extras.visit.islands.map((i) => ({
											fp: i.fp,
											t0: i.t0,
											loaded: i.loaded,
											done: i.done,
											...(i.changed ? { changed: true } : {})
										})),
										firsts: extras.visit.firsts,
										shifts: extras.visit.shifts.length,
										cls_by_island: Object.fromEntries(
											extras.visit.shifts.reduce(
												(m, s) =>
													m.set(
														s.fp ?? '(outside islands)',
														(m.get(s.fp ?? '(outside islands)') ?? 0) + s.value
													),
												new Map<string, number>()
											)
										)
									}
								}
							: {}),
						// the visit's slowest interaction, sampled: what ran while it waited, and in its handlers
						...(extras.interaction_cpu ? { interaction_cpu: extras.interaction_cpu } : {}),
						...(extras.client_cpu
							? {
									cpu: {
										at: extras.client_cpu.at,
										sampled_ms: extras.client_cpu.analysis.duration_ms,
										busy_ms: extras.client_cpu.analysis.busy_ms,
										// each island's hydrate window, and the long tasks outside them: what ran there
										...(extras.client_cpu.windows
											? {
													by_island: Object.entries(extras.client_cpu.windows.islands).map(([fp, w]) => ({
														fp,
														name: island_rows_of(meta).find((r) => r.fp === fp)?.name ?? null,
														ms: w.ms,
														top: w.top
													})),
													outside_islands: extras.client_cpu.windows.outside
												}
											: {}),
										components: extras.client_cpu.analysis.components.slice(0, 30).map((c) => ({
											name: c.name,
											file: c.url,
											self_ms: c.self_ms,
											total_ms: c.total_ms,
											instances: c.calls ?? null
										})),
										hot_functions: extras.client_cpu.analysis.functions.slice(0, 30).map((f) => ({
											name: f.name,
											file: f.url,
											line: f.line,
											category: f.category,
											package: f.pkg ?? null,
											self_ms: f.self_ms,
											total_ms: f.total_ms
										}))
									}
								}
							: {})
					}
				: null,
		// a caught request's replay: the link and the inputs it carries
		replay: meta.request
			? {
					url: `${base}/replay/${meta.id}`,
					path: extras.replay?.path ?? meta.request.path,
					headers: Object.keys(extras.replay?.headers ?? {})
				}
			: null,
		// the document as a byte strip (page mode): bytes per kind, the segments in order
		// every file the page loads at start, weighed (the score's JS / weight / blocking)
		assets: extras.assets
			? {
					totals: extras.assets.totals,
					html: extras.assets.html,
					inline: extras.assets.inline,
					files: extras.assets.assets.slice(0, 40).map((x) => ({
						url: x.url,
						kind: x.kind,
						via: x.via,
						bytes: x.bytes,
						wire: x.wire,
						...(x.blocking ? { blocking: true } : {}),
						...(x.lazy ? { lazy: true } : {}),
						...(x.contains ? { contains: x.contains } : {})
					})),
					...(extras.assets.missed.length ? { missed: extras.assets.missed.slice(0, 20) } : {})
				}
			: extras.assets_missing
				? { missing: extras.assets_missing }
				: null,
		strip: extras.strip
			? {
					total: extras.strip.total,
					by_kind: extras.strip.by_kind,
					shadow_count: extras.strip.shadow_count,
					segments: extras.strip.segments,
					...(extras.strip.chunks ? { chunks: extras.strip.chunks } : {}),
					...(extras.strip.tail ? { tail: extras.strip.tail } : {})
				}
			: null,
		// the data river (page mode): calls → loads → page.data keys → islands, plus the keys nothing reads
		river: extras.river ?? null,
		memory: {
			rss_start_mb: extras.mem[0]?.rss ?? null,
			rss_end_mb: extras.mem.at(-1)?.rss ?? null,
			growth_mb: extras.mem.length >= 2 ? extras.mem.at(-1)!.rss - extras.mem[0].rss : 0,
			gc: extras.gc ?? null,
			// who caused the GC: each pause with the allocations that filled the heap before it, and
			// the allocators with the pause time they are responsible for
			gc_attribution: extras.gc_attr
				? {
						...extras.gc_attr.summary,
						pauses: extras.gc_attr.pauses.map((p) => ({
							t_ms: p.t,
							ms: p.ms,
							ms_measured: p.ms_measured,
							kind: p.kind,
							forced: p.forced,
							since_ms: p.since_ms,
							allocated_bytes: p.allocated,
							estimated: p.estimated ?? false,
							why: p.why,
							running: p.running ?? null,
							top: p.top.map((x) => ({
								name: x.name,
								component: x.component,
								bytes: x.bytes,
								share: x.share
							}))
						})),
						makers: extras.gc_attr.makers.slice(0, 40).map((m) => ({
							name: m.name,
							file: m.url,
							line: m.line,
							category: m.category,
							component: m.component,
							via: m.caller ?? null,
							allocated_bytes: m.allocated,
							share: m.share,
							gc_ms: m.gc_ms,
							pauses: m.pauses
						})),
						components: extras.gc_attr.components.slice(0, 40)
					}
				: null,
			allocators: (extras.heap ?? []).map((h) => ({
				name: h.name,
				file: h.url,
				line: h.line,
				category: h.category,
				self_bytes: h.self_bytes,
				total_bytes: h.total_bytes
			})),
			// bytes charged to the nearest component on the allocating stack (a page, a layout, an island)
			by_component: (extras.heap_components ?? []).map((c) => ({ name: c.name, bytes: c.bytes })),
			samples: extras.mem.map((m) => ({ t_ms: m.t, rss_mb: m.rss, heap_used_mb: m.heap_used }))
		},
		// V8's deoptimizations during the window: which functions, why, how hot
		deopts: a.deopts.map((d) => ({
			name: d.name,
			file: d.url,
			line: d.line,
			category: d.category,
			self_ms: d.self_ms,
			count: d.count,
			reasons: d.reasons
		})),
		// synchronous I/O on the CPU inside the window: each one blocked every request on the instance
		sync_io: sync_io(a).map((s) => ({
			name: s.name,
			module: s.module,
			self_ms: s.self_ms,
			total_ms: s.total_ms,
			calls: s.calls,
			callers: s.callers
		})),
		// functions called many times per render at a steady cost each: a cache keyed on the argument removes them
		memo_candidates: memo_candidates(a, extras.gc_attr?.makers ?? [], 8, runs_of(meta)),
		// promises created in the window, per render, and who created them (sampled)
		promises: extras.promises
			? {
					count: extras.promises.count,
					per_render: meta.runs?.length
						? Math.round(extras.promises.count / meta.runs.length)
						: extras.promises.count,
					top: extras.promises.top
				}
			: null,
		// what one more render left alive after a full collection, by allocation site
		retained: extras.retained
			? {
					total_bytes: extras.retained.total_bytes,
					render_ms: extras.retained.render_ms,
					sites: extras.retained.sites.map((s) => ({
						name: s.name,
						file: s.url,
						line: s.line,
						via: s.caller ?? null,
						component: s.component,
						bytes: s.bytes,
						share: s.share
					}))
				}
			: null,
		// THE RENDER STEP BY STEP: the window's segments in order with running totals and the stack at each
		steps: a.timeline ? (render_steps(a.timeline, a.stacks) ?? null) : null,
		// THE SAMPLES THEMSELVES: every CPU sample of the window with its stack (frames + parent
		// links), the substrate every table above is an aggregate of — query any range or instant
		stacks: a.stacks
			? {
					window_ms: a.stacks.window_ms,
					raw_samples: a.stacks.raw,
					frames: a.stacks.frames.map((f) => ({
						name: f.n,
						file: f.f ?? null,
						category: f.c,
						parent: f.p
					})),
					t_ms: a.stacks.t,
					d_ms: a.stacks.d,
					leaf: a.stacks.leaf
				}
			: null,
		// WHEN THE HEAP GREW and what ran then: the fine series and its bursts
		alloc: extras.alloc
			? {
					grown_mb: extras.alloc.grown_mb,
					period_ms: extras.alloc.period_ms,
					longest_gap_ms: extras.alloc.longest_gap_ms,
					window: extras.alloc.window ?? null,
					bursts: extras.alloc.bursts.map((b) => ({
						t0_ms: b.t0,
						t1_ms: b.t1,
						mb: b.mb,
						mb_per_s: b.rate,
						gc_inside: b.gc,
						running: b.running
					})),
					samples: extras.alloc.samples.map((s) => ({ t_ms: s.t, heap_mb: s.mb }))
				}
			: null,
		// THE INSTANCE WAS NOT ALONE: the other requests that overlapped the profiled render(s)
		contention: extras.contention
			? {
					overlap_ms: extras.contention.overlap_ms,
					cpu_max_ms: extras.contention.cpu_max_ms,
					busy_share: extras.contention.busy_share,
					inflight_at_start: extras.contention.inflight_at_start,
					per_window: extras.contention.per_window,
					requests: extras.contention.requests,
					note: 'cpu_max_ms is an upper bound: a request’s CPU is a process-wide delta over its lifetime, so overlapping requests carry some of each other’s'
				}
			: null,
		// DATA LINEAGE FROM THE CODE: each page.data key with who produced it, who reads it, and a verdict
		lineage: extras.lineage
			? {
					keys: extras.lineage.keys.map((k) => ({
						key: k.key,
						from: k.from,
						shipped_bytes: k.shipped_bytes,
						load_wait_ms: k.load_wait_ms,
						verdict: k.verdict,
						readers: k.readers
					})),
					components: extras.lineage.components,
					unread: extras.lineage.unread.map((k) => k.key),
					server_only: extras.lineage.server_only.map((k) => k.key),
					notes: extras.lineage.notes
				}
			: null,
		// THE EXACT LINES: each costly app line with its code and every cost joined on it
		ledger: extras.ledger ?? null,
		// THE PATTERNS: known slow shapes recognised on those lines, each with its sites and a fix
		// each pattern with its saving and cost for ONE render beside the raw numbers (a CPU pattern's
		// add up every profiled render; a wait's are one render already)
		patterns: extras.patterns
			? extras.patterns.map((p) => {
					const r = p.wait ? 1 : runs_of(meta);
					const r2 = (x: number) => Math.round(x * 100) / 100;
					return {
						...p,
						save_per_render_ms: r2(p.save_ms / r),
						cost_per_render_ms: r2(p.cost_ms / r)
					};
				})
			: null,
		// HEAP GROWTH: a few more renders with a collection after each (leak vs a bounded cache)
		growth: extras.growth ?? null,
		// one render's time as a tree that adds up at every level: phase → owner / call → line
		drill: extras.drill ?? null,
		// one render after every fix named, overlapping fixes counted once
		forecast: extras.forecast ?? null,
		// VALUES, NOT JUST FUNCTIONS: the numbers the spans carried, and how the time moved with them
		span_values: span_values(extras.spans),
		waiting: (() => {
			const m = new Map<string, { caller: string; kind: string; count: number; wait_ms: number }>();
			const add = (caller: string, kind: string, ms: number) => {
				const k = caller + '|' + kind;
				const r = m.get(k) ?? { caller, kind, count: 0, wait_ms: 0 };
				r.count++;
				r.wait_ms = round1(r.wait_ms + ms);
				m.set(k, r);
			};
			for (const c of net) if (c.caller) add(c.caller, 'http', c.ms + (c.body_ms ?? 0));
			for (const o of extras.io ?? [])
				if (o.caller && !o.open) add(o.caller, io_kind(o.type), o.ms);
			return [...m.values()].sort((x, y) => y.wait_ms - x.wait_ms).slice(0, 40);
		})(),
		user_timings: (extras.measures ?? []).map((m) => ({
			name: m.name,
			count: m.count,
			total_ms: m.total_ms,
			avg_ms: round1(m.total_ms / m.count),
			max_ms: m.max_ms
		})),
		requests: meta.requests.map((r) => ({
			method: r.method,
			path: r.path,
			route: r.route,
			status: r.status,
			ms: r.ms,
			cpu_ms: r.cpu_ms,
			wait_ms: round1(Math.max(0, r.ms - r.cpu_ms)),
			net_ms: r.net_ms,
			net_count: r.net_count,
			inflight: r.inflight,
			internal: !!r.internal,
			tags: r.tags ?? null,
			span_count: r.span_count ?? null,
			span_ms: r.span_ms ?? null,
			hole: r.hole ?? null
		})),
		links: {
			html: `${base}/report/${meta.id}`,
			json: `${base}/report/${meta.id}.json`,
			cpuprofile: `${base}/report/${meta.id}/raw`
		}
	};
}

/**
 * A complete, portable dump: everything the report needs to reconstruct the
 * full interactive report later, on any machine. This is the artifact a user
 * downloads from a serverless host (where reports can't be stored) and uploads
 * to the viewer. Rendering needs no inspector, so it works everywhere.
 */
export function report_dump(a: Analysis, meta: ReportMeta, extras: ReportExtras) {
	return { kind: 'ogygia-profiler-dump', version: 1, meta, analysis: a, extras };
}

/** Narrowing guard for an uploaded dump before we render it. */
export function is_dump(
	x: unknown
): x is { meta: ReportMeta; analysis: Analysis; extras: ReportExtras } {
	const d = x as Record<string, unknown> | null;
	return (
		!!d &&
		typeof d === 'object' &&
		d.kind === 'ogygia-profiler-dump' &&
		!!d.meta &&
		!!d.analysis &&
		!!d.extras
	);
}
function top_hosts(
	net: NetCall[]
): { host: string; count: number; total: number; p50: number; max: number; errors: number }[] {
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

/** timeline of network calls, offset from window start */
