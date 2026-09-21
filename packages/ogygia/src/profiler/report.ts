/**
 * Profiler report DATA: the analyzed profile as curated JSON (`report_json`, the agent view), the
 * dump codec that round-trips a report (`report_dump` / `is_dump`), the findings derivation the UI
 * and the JSON both render from, and the request-log types. The HTML rendering moved to the Svelte
 * components in `./ui/` (rendered through `document()`); this file is pure, testable logic.
 */

import type { Analysis, HeapAllocator } from './analyze.js';
import { sequential_ms, type NetCall } from './net.js';
import type { Visit } from './visit.js';
import type { ByteStrip } from './byte-strip.js';
import type { River } from './river.js';
import type { GcAttribution } from './gc.js';
import { sync_io, memo_candidates, span_values, type Retained } from './insights.js';
import type { AllocTimeline } from './alloc.js';
import type { Contention } from './contention.js';
import type { Lineage } from './lineage.js';
import { render_steps } from './steps.js';
import { io_kind, type IoOp } from './async-io.js';
import { chain_steps, PHASE_LABEL } from './timeline.js';
import type { HoleRequestStats, HoleStat, IslandStat, OgygiaRequestStats } from '../server/request-stats.js';
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
	by: Record<string, { value: string; count: number; total_ms: number; wall_ms: number; p50_ms: number; max_ms: number }[]>;
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
	for (const s of spans) if (s.parent !== undefined) (children.get(s.parent) ?? children.set(s.parent, []).get(s.parent)!).push(s);
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
			const done = g.list.filter((s) => !s.open && s.ms >= 0).map((s) => s.ms).sort((a, b) => a - b);
			const hit = g.list.filter((s) => s.attrs?.cache === 'hit').length;
			const miss = g.list.filter((s) => s.attrs?.cache === 'miss');
			const keys = new Set<string>();
			for (const s of g.list) for (const k of Object.keys(s.attrs ?? {})) if (k !== 'cache') keys.add(k);
			// the union of the intervals: what these spans cost in wall time
			const finished = g.list.filter((s) => !s.open && s.ms >= 0);
			const wall = wall_of(finished.map((s) => [s.start, s.start + s.ms] as const));
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
				p50_ms: done[Math.floor(done.length / 2)] ?? 0,
				max_ms: done.at(-1) ?? 0,
				errors: g.list.filter((s) => s.error).length,
				open: g.list.filter((s) => s.open).length,
				...(hit || miss.length
					? { cache: { hit, miss: miss.length, miss_ms: r2(miss.reduce((a, s) => a + Math.max(s.ms, 0), 0)) } }
					: {}),
				callers: [...g.callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c),
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
	/** page mode: a plain note when the run plan was trimmed to fit the serverless budget */
	budget_note?: string;
	/** page mode: each render run, ms, AS THE APP WOULD HAVE PAID IT — the profiler's own share (its
	 *  CPU frames, its part of the GC pauses) taken out; `runs_measured` is what the clock said */
	runs?: number[];
	runs_measured?: number[];
	/** the profiler's own cost inside the window, measured once and kept out of every other number */
	overhead?: { cpu_ms: number; gc_ms: number; per_run_ms: number; per_run?: number[]; note: string };
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
	/** browser-side hydration timings joined by fingerprint (the runtime's beacon) */
	client?: ClientIslandStat[];
	/** the page's web vitals from the same beacon */
	vitals?: PageVitals;
	/** the app's own browser marks (`mark()` from ogygia/profiler/client) for the page, per name */
	client_marks?: ClientMarkStat[];
	/** the browser's CPU profile of the page's hydration (the profiler user's latest visit) */
	client_cpu?: { analysis: Analysis; at: number; sample_ms: number };
	/** a caught request's inputs (path + query, the kept headers): the "profile it again" button */
	replay?: { path: string; headers: Record<string, string> };
	/** the browser's picture of a visit to this page (the beacon) — the one-clock timeline joins it */
	visit?: Visit;
	/** the rendered document as a byte strip */
	strip?: ByteStrip;
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
}

const fmt_kb = (bytes: number) => (bytes < 1024 && bytes > 0 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);
/** page mode renders the page N times; per-render figures divide by it */
const runs_of = (meta: ReportMeta) => (meta.trigger === 'page' ? Math.max(meta.runs?.length ?? 1, 1) : 1);

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
export function n_plus_one(net: NetCall[], min = 5): { host: string; tpl: string; count: number; ms: number }[] {
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
export function derive_findings(a: Analysis, meta: ReportMeta, extras: ReportExtras): Finding[] {
	const out: Finding[] = [];
	type Extra = Pick<Finding, 'fix' | 'anchor' | 'file' | 'line'>;
	const info = (code: string, message: string, extra: Extra = {}) =>
		out.push({ severity: 'info', code, message, ...extra });
	const warn = (code: string, message: string, extra: Extra = {}) =>
		out.push({ severity: 'warn', code, message, ...extra });

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
			// no component work AND barely any samples: either a non-render or a page so fast there is
			// nothing to see. Either way the verdict can't be trusted — say so instead of dressing it up.
			warn(
				'low-confidence',
				`Only ${a.sample_count} CPU sample${a.sample_count === 1 ? '' : 's'} and no components were ` +
					`seen — the render was too fast or too small to profile accurately. If the page is genuinely ` +
					`instant it may be cached/prerendered; otherwise the wrong URL was profiled.`
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
					(p.wait_ms >= 0.5 ? ` + ${fmt_ms(p.wait_ms)} ms waiting` : '')
			);
		if (parts.length) {
			info(
				'phases',
				`Of the ${fmt_ms(tl.window_ms)} ms render: ${parts.join(' · ')}` +
					(tl.gap_ms >= tl.window_ms * 0.05 ? ` · ${fmt_ms(tl.gap_ms)} ms unaccounted` : '') +
					'.'
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

	if (!tl?.parallelizable.length && net.length >= 2 && seq > meta.duration_ms * 0.5 && busy_pct < 60) {
		warn(
			'sequential-network',
			`Network calls ran back-to-back for ${fmt_ms(seq)} ms of the window — usually sequential awaits.`,
			{ fix: 'Start independent calls together with Promise.all.' }
		);
	} else if (busy_pct < 25 && meta.trigger !== 'window') {
		info(
			'mostly-waiting',
			net.length
				? 'Mostly waiting on the network, not computing.'
				: 'Mostly waiting, but no HTTP calls were seen. The wait is likely a database/socket client or a timer.'
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
			`Biggest CPU consumer: ${tb.key} (${fmt_ms(tb.self_ms)} ms, ${fmt_pct(tb.self_ms, a.busy_ms)} of busy time).`
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
		const at = { anchor: `comp:${heavy.name}`, file: heavy.url, line: heavy.line };
		if (n >= 20) {
			warn(
				'component-repeat',
				`${heavy.name} rendered ${n} times — ${fmt_ms(heavy.total_ms)} ms, ${fmt_pct(heavy.total_ms, a.busy_ms)} of busy, ${fmt_ms(heavy.total_ms / n)} ms each.`,
				{
					...at,
					fix: 'Render fewer: paginate or window the list, or move it below the fold into a deferred hole so the page ships without it.'
				}
			);
		} else if (heavy.total_ms / Math.max(n, 1) >= 20) {
			// what inside it burns: the hot function whose heaviest stack passes through this component
			const inside = a.functions.find(
				(f) =>
					f.key !== heavy.key &&
					f.self_ms >= heavy.total_ms * 0.2 &&
					f.stacks?.[0]?.frames.some((fr) => fr.n === heavy.name)
			);
			warn(
				'component-heavy',
				`One render of ${heavy.name} costs ${fmt_ms(heavy.total_ms / Math.max(n, 1))} ms (${fmt_pct(heavy.total_ms, a.busy_ms)} of busy)` +
					(inside ? ` — most of it is ${inside.name} (${inside.url}:${inside.line}), ${fmt_ms(inside.self_ms)} ms.` : '.'),
				{
					...at,
					fix: 'Compute the expensive part once (in load, or a per-request cache) and pass the result as a prop, or render it in a deferred hole.'
				}
			);
		} else {
			info('top-component', `Most expensive component: ${heavy.name} at ${fmt_ms(heavy.total_ms)} ms total.`, at);
		}
	} else if (by_total[0]) {
		const tc = by_total[0];
		info('top-component', `Most expensive component: ${tc.name} at ${fmt_ms(tc.total_ms)} ms total.`, {
			anchor: `comp:${tc.name}`,
			file: tc.url,
			line: tc.line
		});
	}
	// HOT FUNCTION: one function (yours or a dependency's) burning a fifth of the CPU.
	const hot = a.functions.find((f) => f.category === 'app' || f.category === 'dependency');
	if (hot && hot.self_ms >= a.busy_ms * 0.2 && hot.self_ms >= 5) {
		const from = hot.stacks?.[0]?.frames.find((fr) => fr.c === 'component' || fr.c === 'app');
		warn(
			'hot-function',
			`${hot.name} burns ${fmt_ms(hot.self_ms)} ms (${fmt_pct(hot.self_ms, a.busy_ms)} of busy) at ${hot.url}:${hot.line}` +
				(hot.calls ? `, ${hot.calls} calls` : '') +
				(from ? `, called from ${from.n}` : '') +
				'.',
			{
				anchor: `fn:${hot.key}`,
				file: hot.url,
				line: hot.line,
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
	const ser_ms = ser.reduce((s, f) => s + f.self_ms, 0);
	if (ser_ms >= a.busy_ms * 0.1 && ser_ms >= 5) {
		warn(
			'serialization',
			`Serializing data took ${fmt_ms(ser_ms)} ms (${fmt_pct(ser_ms, a.busy_ms)} of busy) — the page's load data and island props on their way to the browser.`,
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
			warn('span-open', `${s.name} never ended ${s.open} time${s.open === 1 ? '' : 's'}${site} — a hung call, or a span.start() without end().`);
		}
		const wall_per_render = s.wall_ms / runs;
		if (per_render >= 5 && wall_per_render >= Math.max(5, window_ms * 0.05)) {
			// the breakdown's biggest value, when the spans carry one (`ds.render` by tag)
			const bk = Object.keys(s.by)[0];
			const top = bk ? s.by[bk][0] : undefined;
			const by_top =
				top && bk && !top.value.startsWith('(')
					? ` Most of it is ${bk} ${top.value}: ${Math.round(top.count / runs)} of them, ${fmt_ms(top.wall_ms / runs)} ms of wall${top.wall_ms < top.total_ms * 0.6 ? ` (${fmt_ms(top.total_ms / runs)} ms summed)` : ''}.`
					: '';
			// ran together (a Promise.all: the summed time is far above the wall) or one after another?
			if (s.wall_ms < s.total_ms * 0.6) {
				warn(
					'span-repeat',
					`${s.name} ran ${Math.round(per_render)} times in one render${site}, together: ${fmt_ms(wall_per_render)} ms of wall for ${fmt_ms(ms_per_render)} ms of summed work, ${fmt_ms(s.p50_ms)} ms each.${by_top}`,
					{
						fix: 'They already overlap, so batching gains little: the cost is each one (make it cheaper, or cache it) and how many there are (render fewer).'
					}
				);
			} else {
				warn(
					'span-repeat',
					`${s.name} ran ${Math.round(per_render)} times in one render${site}, ${fmt_ms(ms_per_render)} ms together, ${fmt_ms(s.p50_ms)} ms each.${by_top}`,
					{
						fix: 'Once per item is the N+1 shape: batch it (one call for all the ids), or fetch the parent with its children included.'
					}
				);
			}
		} else if (ms_per_render >= Math.max(10, window_ms * 0.2)) {
			warn(
				'span-slow',
				`${s.name} took ${fmt_ms(ms_per_render)} ms of the render${site}${per_render > 1 ? `, over ${Math.round(per_render)} calls` : ''}.`,
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
			`Kit hashed the whole HTML for its ETag: ${fmt_ms(etag.self_ms)} ms per render` +
				(bytes ? ` over ${fmt_kb(bytes)}` : '') +
				'.',
			{
				anchor: `fn:${etag.key}`,
				fix: 'Only a smaller document helps (fewer bytes in the seed and props, less markup) — the hash itself is Kit’s, not yours.'
			}
		);
	}
	// OGYGIA'S OWN COST on the profiled page.
	const og = [...meta.requests].filter((r) => r.og).sort((x, y) => (y.og!.seed_bytes + y.og!.tail_bytes) - (x.og!.seed_bytes + x.og!.tail_bytes))[0]?.og;
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
	kit_findings(a, meta, info, warn);
	accuracy_findings(a, meta, extras, info, warn);
	// PATHS: several hot functions under one caller — the one place to fix (the graph is below)
	for (const g of (a.paths ?? []).slice(0, 3)) {
		const say = g.ms >= a.busy_ms * 0.15 ? warn : info;
		say(
			'path-group',
			`${g.fns.length} hot functions sit on one path under ${g.owner.name}: ${g.fns.slice(0, 4).map((f) => f.name).join(', ')}${g.fns.length > 4 ? ` and ${g.fns.length - 4} more` : ''} — ${fmt_ms(g.ms)} ms together (${fmt_pct(g.ms, a.busy_ms)} of busy).`,
			{
				anchor: g.owner.category === 'component' ? `comp:${g.owner.name}` : `fn:${g.owner.key}`,
				file: g.owner.url,
				line: g.owner.line,
				fix: `Fix ${g.owner.name} once — call it less, cache what it computes, or move it out of the render — rather than each function on its own; the graph under "Paths to fix" shows the chain.`
			}
		);
	}

	if (a.gc_ms > a.busy_ms * 0.15 && a.gc_ms > 5) {
		warn(
			'gc-heavy',
			`Garbage collection took ${fmt_pct(a.gc_ms, a.busy_ms)} of busy time — see the allocators for who creates the garbage.`
		);
	}
	// WHAT A RENDER LEAVES BEHIND: the heap kept after one more render and a full collection
	if (extras.retained && extras.retained.total_bytes >= 5 * 1048576) {
		const r = extras.retained;
		const top = r.sites.slice(0, 3).map((s) => `${s.name}${s.caller ? ` via ${s.caller}` : ''}${s.component ? ` in ${s.component}` : ''} (${Math.round((s.bytes / 1048576) * 10) / 10} MB)`).join(', ');
		warn('retained-per-render', `One render leaves ${Math.round((r.total_bytes / 1048576) * 10) / 10} MB alive after a full collection: ${top}. Every render adds that much; the instance grows until it restarts.`, {
			fix: 'Whatever holds these (a module-level cache, a registry, a closure kept by a long-lived object) must release them or be bounded. The sites named are where the kept objects were made; what keeps them is their owner.',
			...(r.sites[0]?.url ? { file: r.sites[0].url, line: r.sites[0].line } : {})
		});
	}
	// DEOPTIMIZATIONS: a hot function V8 keeps throwing out of optimized code
	for (const d of a.deopts.slice(0, 3)) {
		if (d.self_ms < Math.max(2, a.busy_ms * 0.01) || d.count < 2) continue;
		const why = Object.entries(d.reasons).sort((x, y) => y[1] - x[1]).map(([r, n]) => `${r} ×${n}`).join(', ');
		warn('deopt', `${d.name} was deoptimized ${d.count} times in the window (${why}) and cost ${fmt_ms(d.self_ms)} ms of CPU: it runs in slow code most of the time.`, {
			fix: 'A deopt reason names the assumption that broke: "wrong map" is objects of different shapes at one site (keep the same properties in the same order), "not a Smi" is a number that became a float or a string, a megamorphic call site is many types through one call. Give the function one shape and it stays optimized.',
			anchor: `fn:${d.key}`,
			file: d.url,
			line: d.line
		});
	}
	// SYNC I/O inside the render: blocks every other request on the instance
	const sync = sync_io(a);
	const sync_ms = sync.reduce((s, r) => s + r.total_ms, 0);
	if (sync_ms >= 2) {
		const top = sync[0];
		warn('sync-io', `${fmt_ms(sync_ms)} ms of synchronous I/O on the CPU during the window: ${sync.slice(0, 3).map((s) => `${s.name} ${fmt_ms(s.total_ms)} ms${s.callers[0] ? ` from ${s.callers[0]}` : ''}`).join(', ')}. While it runs no other request on this instance moves.`, {
			fix: 'Use the async form (fs.promises, zlib promises, execFile with a callback), or do it once at start-up and keep the result.',
			anchor: `fn:${top.key}`
		});
	}
	// PROMISE STORM: tens of thousands of promises per render is a cost no function shows
	if (extras.promises) {
		const per = meta.runs?.length ? extras.promises.count / meta.runs.length : extras.promises.count;
		if (per >= 10_000) {
			const top = extras.promises.top.slice(0, 3).map((t) => `${t.caller} ${Math.round(t.share * 100)}%`).join(', ');
			warn('promise-storm', `${Math.round(per).toLocaleString()} promises per render. Each is an allocation and a microtask; at this volume they are a cost no single function shows.${top ? ` Mostly from: ${top}.` : ''}`, {
				fix: 'Find the loop that awaits per item (a render per tag, a fetch per row) and do the work in one call, or on a plain array without async at all.'
			});
		}
	}
	// MEMOIZATION CANDIDATES: the same computation many times per render
	for (const m of memo_candidates(a, extras.gc_attr?.makers ?? []).slice(0, 2)) {
		info('memo-candidate', `${m.name} runs ${m.calls} times per render at ${m.per_call_ms} ms each (${fmt_ms(m.total_ms)} ms)${m.alloc_per_call ? `, allocating ${Math.round(m.alloc_per_call / 1024)} KB per call` : ''}${m.parent ? `, mostly under ${m.parent}` : ''}. If its result depends only on its argument, a cache keyed on it runs it once per distinct value.`, {
			anchor: `fn:${m.key}`,
			file: m.url,
			line: m.line
		});
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
				`${fmt_ms(m.gc_ms)} ms of the ${fmt_ms(g.summary.total_ms)} ms of GC is the garbage ${m.name}${via} makes${where}: ${Math.round((m.allocated / 1048576) * 10) / 10} MB of the ${g.summary.allocated_mb} MB allocated in the window (${Math.round(m.share * 100)}%)${m.pauses ? `, on the causing side of ${m.pauses} pause${m.pauses === 1 ? '' : 's'}` : `, across the window's ${g.summary.count} pause${g.summary.count === 1 ? '' : 's'}`}.`,
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
			info('alloc-burst', `${b.mb} MB of the ${al.grown_mb} MB the heap grew came in one ${fmt_ms(b.t1 - b.t0)} ms stretch (${b.rate} MB/s)${who ? `, while ${who.label} ran` : ''}${b.gc ? ' — and a collection fell inside it, so the allocation was more than the growth shows' : ''}.`, {
				fix: 'Look at the allocators table for that stretch: the makers with a caller there are the ones filling the heap that fast.',
				...(who?.file ? { file: who.file } : {})
			});
		}
	}
	// THE INSTANCE WAS NOT ALONE
	const ct = extras.contention;
	if (ct && ct.requests.length) {
		const others = ct.requests.filter((r) => r.kind === 'other');
		const holes = ct.requests.length - others.length;
		const win = meta.trigger === 'page' ? Math.max(meta.runs?.length ?? 1, 1) : 1;
		if (others.length && ct.busy_share >= 0.1) {
			const top = others.slice(0, 3).map((r) => `${r.method} ${r.path}`).join(', ');
			warn('busy-instance', `${others.length} other request${others.length === 1 ? '' : 's'} ran on this instance during the profiled render${win > 1 ? 's' : ''} (${top}${others.length > 3 ? ', …' : ''}), in flight for ${Math.round(ct.busy_share * 100)}% of the window: up to ${fmt_ms(ct.cpu_max_ms)} ms of its wall time was the event loop serving them, and the render's own numbers carry that wait.`, {
				fix: 'Record again on a quiet instance, or read the CPU numbers (they exclude the others) rather than the wall time. Sustained, this is what horizontal scaling or a worker pool is for.'
			});
		}
		const selfs = ct.requests.filter((r) => r.kind === 'self');
		if (selfs.length) {
			const paths = [...new Set(selfs.map((r) => r.path))];
			const per = Math.round(selfs.length / win);
			const self_ms = selfs.reduce((s, r) => s + r.ms, 0) / win;
			info('self-fetch', `The render called its own server ${per} time${per === 1 ? '' : 's'} (${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''}), ${fmt_ms(self_ms)} ms of requests answered by the same event loop that was rendering: the page waited on itself, and every one of those calls paid a full HTTP round trip to reach code in the same process.`, {
				fix: 'Call the function behind the endpoint directly from the load (import it), or use a remote function; keep fetch for servers that are not this one.'
			});
		}
		if (holes && !others.length && !selfs.length) {
			info('holes-in-flight', `${holes} of the page's own hole request${holes === 1 ? '' : 's'} ${holes === 1 ? 'was' : 'were'} answered while it rendered: the deferred islands cost the instance CPU on the page's own clock.`);
		}
	}
	// DATA LINEAGE: keys fetched for nobody, keys shipped for the server alone
	const ln = extras.lineage;
	if (ln) {
		const unread = ln.unread.filter((k) => k.from);
		if (unread.length) {
			const with_wait = unread.filter((k) => (k.load_wait_ms ?? 0) > 0);
			const names = unread.slice(0, 4).map((k) => `${k.key} (${k.from})`).join(', ');
			const wait = with_wait.reduce((s, k) => s + (k.load_wait_ms ?? 0), 0);
			warn('key-unread', `${unread.length} page.data key${unread.length === 1 ? '' : 's'} no component reads: ${names}${unread.length > 4 ? ', …' : ''}.${wait > 0 ? ` The load${with_wait.length > 1 ? 's' : ''} behind ${with_wait.length > 1 ? 'them' : 'it'} waited ${fmt_ms(wait)} ms on upstream calls per render.` : ''}`, {
				fix: 'Drop the key from the load, or the call that produces it — nothing on the page uses it. A key read through a spread or a whole-object pass-through would show as unknown, not unread.',
				file: unread[0].from!
			});
		}
		const so = ln.server_only.filter((k) => k.shipped_bytes >= 2048);
		if (so.length) {
			const bytes = so.reduce((s, k) => s + k.shipped_bytes, 0);
			info('seed-server-only', `${fmt_kb(bytes)} of the seed is ${so.length} key${so.length === 1 ? '' : 's'} only the server renders (${so.slice(0, 4).map((k) => k.key).join(', ')}${so.length > 4 ? ', …' : ''}): shipped to the browser, read by no island.`, {
				fix: 'The seed ships the keys islands read; a key here is read by a server component through a name the shaping could not see. Check the island’s closure.'
			});
		}
	}
	// VALUES: a span whose time follows one of its numbers
	for (const v of span_values(extras.spans)) {
		if (v.r !== undefined && v.r >= 0.8 && v.n >= 5 && v.ms_per_unit !== undefined && v.ms_per_unit > 0) {
			info('value-driven', `${v.span} scales with ${v.attr}: about ${v.ms_per_unit >= 0.01 ? v.ms_per_unit : v.ms_per_unit.toExponential(1)} ms per unit over ${v.n} spans (${v.attr} ${v.min}–${v.max}, fit r=${v.r}). Halving the ${v.attr} halves the span.`);
			break;
		}
	}
	if (extras.gc && extras.gc.max_ms > 20) {
		warn(
			'gc-pause',
			`Longest single GC pause: ${fmt_ms(extras.gc.max_ms)} ms (${extras.gc.count} pauses, ${fmt_ms(extras.gc.total_ms)} ms total). A long pause freezes every request at once.`
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
	return out;
}

type Say = (code: string, message: string, extra?: Pick<Finding, 'fix' | 'anchor' | 'file' | 'line'>) => void;

/** The island rows of the profiled page: the page request that recorded them (detail is on only
 *  while the profiler records, so the internal render carries them). */
export function island_rows_of(meta: ReportMeta): IslandStat[] {
	return meta.requests.find((r) => r.og?.island_rows?.length)?.og?.island_rows ?? [];
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
export function island_host_renamer(requests: readonly RequestEntry[]): ((name: string, url: string) => string | undefined) | undefined {
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
	const out = new Map<string, { id: string; hit: number; miss: number; none: number; ms: number; ttl: number }>();
	for (const r of meta.requests) {
		if (!r.hole) continue;
		const e = out.get(r.hole.id) ?? { id: r.hole.id, hit: 0, miss: 0, none: 0, ms: 0, ttl: r.hole.ttl };
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
export function island_js_bytes(row: IslandStat, weights: Record<string, number> | undefined): number | null {
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

/** ogygia-specific findings: the seed explained, devalue culprits, the wake advisor, hole economics,
 *  island JS weight and the browser's own hydration timings. */
function ogygia_findings(og: OgygiaRequestStats, meta: ReportMeta, extras: ReportExtras, info: Say, warn: Say): void {
	const islands = group_islands(island_rows_of(meta));
	const names = (list: string[], max = 3) =>
		list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
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
			{ fix: 'Send that value as a plain string or number (a Date as toISOString(), a Map as an object), or keep it out of page.data.' }
		);
	}
	const devalued = islands.filter((r) => !r.json && r.culprit).sort((x, y) => y.props_bytes - x.props_bytes);
	if (devalued.length) {
		const d = devalued[0];
		const say = d.props_bytes >= 2048 ? warn : info;
		say(
			'props-devalue',
			`${island_name(d)}'s props (${fmt_kb(d.props_bytes)}${d.count > 1 ? `, ×${d.count}` : ''}) use devalue because of ${d.culprit}` +
				(devalued.length > 1 ? `; ${devalued.length - 1} more island${devalued.length > 2 ? 's' : ''} likewise.` : '.'),
			{ fix: 'JSON props parse on the fast lane in the browser: pass the value as a string or number, or derive it inside the island.' }
		);
	}
	// THE WAKE ADVISOR: an island whose components carry no interactivity at all ships JS for nothing;
	// many copies of a small interactive island each waking on their own pay per copy.
	const inert = islands.filter(
		(r) =>
			r.interactivity &&
			r.interactivity.files > 0 &&
			r.wake !== 'none' &&
			r.interactivity.handlers + r.interactivity.state + r.interactivity.effects + r.interactivity.binds + r.interactivity.actions === 0
	);
	if (inert.length) {
		const js = inert.reduce((s, r) => s + (island_js_bytes(r, extras.weights) ?? 0), 0);
		warn(
			'wake-inert',
			`${names(inert.map(island_name))} wake${inert.length === 1 ? 's' : ''} (${names([...new Set(inert.map((r) => r.wake))])}) but the build found no event handlers, $state, $effect, bind: or use: in ${inert.length === 1 ? 'its' : 'their'} components` +
				(js ? ` — ${fmt_kb(js)} of JS loads for markup that never changes.` : '.'),
			{ fix: "Ship them as lakes (wake: 'none'): the server markup stays, the module never downloads." }
		);
	}
	const crowds = islands.filter((r) => r.count >= 10 && (r.wake === 'load' || r.wake === 'idle' || r.wake === 'visible'));
	for (const c of crowds.slice(0, 2)) {
		info(
			'wake-crowd',
			`${island_name(c)} has ${c.count} copies on the page, each waking on ${c.wake} with its own ${fmt_kb(Math.round(c.props_bytes / Math.max(c.variants ?? 1, 1)))} of props.`,
			{ fix: "One island around the list hydrates once; or wake: 'interaction' so a copy pays only when touched." }
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
		if (total >= 300 * 1024 && heaviest) {
			warn(
				'islands-js-heavy',
				`The page's islands load ${fmt_kb(total)} of JS in all (${seen.size} modules); ${island_name(heaviest.row)} alone pulls ${fmt_kb(heaviest.bytes)}.`,
				{ fix: 'Open the Islands table: a heavy closure is usually one import (a date or i18n library, a whole component kit) reachable from the island — move it server-side or behind a dynamic import.' }
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
				{ fix: 'The cache key carries the props and the session seal: per-visitor props (a user id, a timestamp) make every key unique. Pass only what the hole renders from.' }
			);
		} else if (e.ttl > 0 && e.hit > 0) {
			info('hole-cache', `The hole ${label(e.id)}: ${e.hit} of ${total} requests served from the render cache (maxAge ${e.ttl}s).`);
		}
	}
	const uncached = rows.filter((h) => h.ttl === 0);
	if (uncached.length && econ.size) {
		const slow = [...econ.values()].filter((e) => e.ttl === 0 && e.ms / Math.max(e.hit + e.miss + e.none, 1) >= 20);
		if (slow.length) {
			info(
				'hole-uncached',
				`${slow.length} hole${slow.length === 1 ? '' : 's'} render${slow.length === 1 ? 's' : ''} fresh on every visit: ${names(slow.map((e) => `${label(e.id)} at ${fmt_ms(e.ms / Math.max(e.hit + e.miss + e.none, 1))} ms`))}.`,
				{ fix: "Content that is the same for every visitor for a while can take a maxAge (a preset: { render: 'deferred', maxAge: '5m' }): the endpoint then serves the memo." }
			);
		}
	}
	// THE BROWSER'S SIDE: hydration timings the runtime beaconed, joined by fingerprint.
	const client = extras.client ?? [];
	// NEVER WOKE: the beacon works (other islands reported) but an island that should wake never
	// did — nothing scrolled it into view, its wake threw, or something on the page stopped it
	if (client.length) {
		const seen = new Set(client.map((c) => c.entry));
		const silent = islands.filter((r) => (r.wake === 'load' || r.wake === 'idle' || r.wake === 'visible') && !seen.has(r.entry));
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
		const total = client.reduce((s, c) => s + c.p50_ms, 0);
		info(
			'client-hydrate',
			`In the browser, ${client.length} island${client.length === 1 ? '' : 's'} reported hydration: ${fmt_ms(total)} ms in all (p50), the slowest ${island_name(slow)} at ${fmt_ms(slow.p50_ms)} ms` +
				(slow.load_p50_ms >= slow.p50_ms * 0.6 ? `, mostly loading its ${fmt_ms(slow.load_p50_ms)} ms of modules.` : '.'),
			{
				fix:
					slow.load_p50_ms >= slow.p50_ms * 0.6
						? 'Module load dominates: a smaller closure (see the Islands table) or an earlier preload helps more than faster code.'
						: 'The hydrate step itself is slow: fewer elements per island, or split the island so the interactive part is small.'
			}
		);
	}
}

/** Kit-shaped findings: the load lanes and the parent() chain, universal loads, and the client
 *  router's serialization of load data. */
function kit_findings(a: Analysis, meta: ReportMeta, info: Say, warn: Say): void {
	const tl = a.timeline;
	if (tl?.chain) {
		const c = tl.chain;
		warn(
			'parent-chain',
			`${c.page} started only after ${c.layout} finished (${fmt_ms(c.serial_ms)} ms later)` +
				(c.explicit ? ' — it awaits parent().' : ' — Kit runs a page load and its layout loads together unless the page awaits parent().'),
			{
				fix: 'Move the await parent() below the page\'s own fetches (start them first, await parent() after), or pass what the page needs some other way — the two loads then overlap.'
			}
		);
	}
	for (const l of tl?.lanes ?? []) {
		if (l.kind === 'universal' && l.wait_ms >= 5) {
			info(
				'universal-load',
				`${l.file} is a universal load: on this render it waited ${fmt_ms(l.wait_ms)} ms on calls. On a page with the client router it runs again in the browser on every navigation, and its data must be serializable.`,
				{ fix: 'If it only needs the server (a database, a secret, a private API), rename it +' + l.level + '.server.ts and the browser never runs it.' }
			);
		}
	}
	// KIT'S UNEVAL: the client router's copy of the load data. ogygia's islands take their data by
	// props and the seed — on a csr=false page this cost is gone.
	const uneval = a.functions.filter((f) => f.pkg === 'devalue' && f.name === 'uneval');
	const uneval_ms = uneval.reduce((s, f) => s + f.self_ms, 0);
	const runs = meta.trigger === 'page' ? Math.max(meta.runs?.length ?? 1, 1) : 1;
	if (uneval_ms >= 3 && uneval_ms >= a.busy_ms * 0.03) {
		info(
			'kit-uneval',
			`Kit serialized the load data for its client router: ${fmt_ms(uneval_ms / runs)} ms per render (devalue.uneval). This page has csr on.`,
			{
				anchor: `fn:${uneval[0].key}`,
				fix: 'With ogygia islands on a csr=false page this cost is zero — the islands get their data from props and the seed, and the document stays static.'
			}
		);
	}
	// {#each} HOT LISTS and MARKUP-HEAVY components: the parent that renders the rows, and whether a
	// component's time is its template or its script.
	const busy = a.busy_ms || 1;
	// `calls` comes from ONE coverage render (per render already); total_ms spans every run
	const list = a.components.find((c) => (c.calls ?? 0) >= 20 && c.parent && c.total_ms >= busy * 0.1);
	if (list) {
		const n = list.calls ?? 0;
		info(
			'hot-list',
			`${list.parent} renders ${n} ${list.name} rows per render, ${fmt_ms(list.total_ms / runs)} ms together (${fmt_ms(list.total_ms / runs / Math.max(n, 1))} ms each).`,
			{ anchor: `comp:${list.parent}`, fix: 'The list is the cost, not the row: page it, window it, or defer the part below the fold into a hole.' }
		);
	}
	const split = a.components.find(
		(c) => (c.markup_ms ?? 0) + (c.logic_ms ?? 0) >= busy * 0.15 && (c.markup_ms ?? 0) + (c.logic_ms ?? 0) >= 5
	);
	if (split) {
		const m = split.markup_ms ?? 0;
		const l = split.logic_ms ?? 0;
		const own = m + l;
		if (m >= own * 0.7) {
			info(
				'markup-heavy',
				`${split.name}'s own time is mostly building markup: ${fmt_ms(m)} of ${fmt_ms(own)} ms is Svelte writing its template, ${fmt_ms(l)} ms its script.`,
				{ anchor: `comp:${split.name}`, fix: 'Fewer elements and attributes per instance help here; the script is not the problem. Static blocks can move into a lake or a prebaked snippet.' }
			);
		} else if (l >= own * 0.7) {
			info(
				'logic-heavy',
				`${split.name}'s own time is mostly its script: ${fmt_ms(l)} of ${fmt_ms(own)} ms runs code, only ${fmt_ms(m)} ms writes markup.`,
				{ anchor: `comp:${split.name}`, fix: 'Open the row: the hot function under it is the one to hoist into load or cache per request.' }
			);
		}
	}
}

/** Cold vs warm per file: what the first render paid over a warm one (module load + compile). */
export function cold_rows(a: Analysis, meta: ReportMeta): { file: string; category: import('./analyze.js').FrameCategory; cold_ms: number; warm_ms: number; extra_ms: number }[] {
	if (!meta.cold) return [];
	const runs = runs_of(meta);
	const warm = new Map(a.files.map((f) => [f.key, f.self_ms / runs]));
	return meta.cold.files
		.map((f) => {
			const w = warm.get(f.file) ?? 0;
			return { file: f.file, category: f.category, cold_ms: f.ms, warm_ms: round1(w), extra_ms: round1(f.ms - w) };
		})
		.filter((r) => r.extra_ms >= 0.5)
		.sort((x, y) => y.extra_ms - x.extra_ms);
}

/** The spread of a component across runs: median of the rest against the max, and the cold first run. */
export function run_spread(runs_ms: number[]): { min: number; median: number; max: number; max_run: number; after: number; cold: boolean } | null {
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

/** Findings from the accuracy round: the upstream's own split of a wait, the cold render, a
 *  component whose runs disagree, and the browser's vitals against the server's render. */
function accuracy_findings(a: Analysis, meta: ReportMeta, extras: ReportExtras, info: Say, warn: Say): void {
	const runs = runs_of(meta);
	// UPSTREAM SPLIT: the slowest call that told us, through Server-Timing, where ITS time went.
	const told = extras.net
		.filter((c) => c.ms >= 0 && c.timings?.length)
		.sort((x, y) => y.ms + (y.body_ms ?? 0) - (x.ms + (x.body_ms ?? 0)))[0];
	if (told && told.ms >= 20) {
		const theirs = told.timings!.reduce((s, t) => s + t.ms, 0);
		const parts = told.timings!
			.filter((t) => t.ms > 0)
			.sort((x, y) => y.ms - x.ms)
			.slice(0, 4)
			.map((t) => `${t.desc ?? t.name} ${fmt_ms(t.ms)} ms`)
			.join(', ');
		const { host, tpl } = path_template(told.url);
		info(
			'upstream-split',
			`${told.method} ${host}${tpl} waited ${fmt_ms(told.ms)} ms; its own Server-Timing says ${parts || 'nothing measurable'}` +
				(theirs > 0 ? ` — ${fmt_ms(theirs)} ms of the wait is on their side, ${fmt_ms(Math.max(0, told.ms - theirs))} ms is the network and their framework.` : '.'),
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
		if (meta.cold.ms >= warm * 1.5 && meta.cold.ms - warm >= 50) {
			warn(
				'cold-start',
				`The first render took ${fmt_ms(meta.cold.ms)} ms against ${fmt_ms(warm)} ms warm: ${fmt_ms(meta.cold.ms - warm)} ms of module load and compile` +
					(rows[0] ? `, most of it ${rows[0].file} (${fmt_ms(rows[0].extra_ms)} ms)` : '') +
					'. On a serverless host every cold instance pays this.',
				{
					fix: 'Fewer and smaller server modules on the page’s path: lazy-import what the render rarely needs, keep heavy libraries out of hooks and layouts, and prefer a warm instance (provisioned concurrency) where the platform offers one.'
				}
			);
		} else if (rows.length && extra >= 20) {
			info('cold-start', `The first render paid ${fmt_ms(extra)} ms of module load and compile over a warm one, most of it ${rows[0].file} (${fmt_ms(rows[0].extra_ms)} ms).`);
		}
	}
	// RUN VARIANCE: a component whose runs disagree is a cache, not a slow render.
	if (runs > 1) {
		const spread = a.components
			.map((c) => ({ c, s: c.runs_ms ? run_spread(c.runs_ms) : null }))
			.filter((x): x is { c: (typeof a.components)[number]; s: NonNullable<ReturnType<typeof run_spread>> } => !!x.s && x.s.max >= 5)
			.sort((x, y) => y.s.max - y.s.median - (x.s.max - x.s.median))[0];
		if (spread && spread.s.cold) {
			info(
				'component-cold-run',
				`${spread.c.name} took ${fmt_ms(spread.s.max)} ms in the first render and ${fmt_ms(spread.s.after)} ms after: a cache that was cold, or a lazy import — not a slow component.`,
				{ anchor: `comp:${spread.c.name}`, fix: 'Warm it at startup, or accept it: only the first request after a deploy pays this.' }
			);
		} else if (spread && spread.s.max >= spread.s.median * 3 && spread.s.max - spread.s.median >= 10) {
			warn(
				'component-variance',
				`${spread.c.name} is ${fmt_ms(spread.s.median)} ms in most renders but ${fmt_ms(spread.s.max)} ms in run ${spread.s.max_run}: something it waits on or caches is not steady.`,
				{ anchor: `comp:${spread.c.name}`, fix: 'Open the row: the per-run column shows the spread; a cache with a short TTL, a GC pause, or a shared upstream are the usual causes.' }
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
			{ fix: slow.p50_ms >= 300 ? `${slow.name} is a wait the visitor feels after the HTML arrived: it is not the server render, take it to whatever ${slow.name} times.` : undefined }
		);
	}
	// THE BROWSER: vitals against the server's render — where the user's time really went.
	const v = extras.vitals;
	if (v && v.lcp !== null) {
		const server = meta.runs?.length ? [...meta.runs].sort((x, y) => x - y)[Math.floor(meta.runs.length / 2)] : meta.request?.ms ?? 0;
		const ttfb = v.ttfb ?? 0;
		if (v.lcp - ttfb >= Math.max(500, ttfb) && server > 0) {
			warn(
				'lcp-gap',
				`In the browser LCP is ${fmt_ms(v.lcp)} ms while the server answered in ${fmt_ms(ttfb)} ms (TTFB; the render itself ${fmt_ms(server)} ms): ${fmt_ms(v.lcp - ttfb)} ms of the user's wait is after the HTML arrived — assets, fonts, hydration.`,
				{ fix: 'Make the hero markup static (a lake), preload its image and font, and keep the islands above the fold small: the server is not the bottleneck here.' }
			);
		} else if (ttfb > 0 && ttfb >= server * 2 && ttfb - server >= 200) {
			warn(
				'ttfb-gap',
				`TTFB in the browser is ${fmt_ms(ttfb)} ms but this server rendered the page in ${fmt_ms(server)} ms: ${fmt_ms(ttfb - server)} ms sits between the two — a cold instance, a proxy, or the network.`,
				{ fix: 'Look at the cold-start section and at what fronts the server (a CDN, an auth proxy): the render is not where that time goes.' }
			);
		} else {
			info('browser-vitals', `The browser measured TTFB ${v.ttfb === null ? '—' : fmt_ms(v.ttfb) + ' ms'}, LCP ${fmt_ms(v.lcp)} ms${v.cls !== null ? `, CLS ${v.cls}` : ''}${v.inp !== null ? `, INP ${fmt_ms(v.inp)} ms` : ''} over ${v.n} visit${v.n === 1 ? '' : 's'}.`);
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
			owner: { name: g.owner.name, file: g.owner.url, line: g.owner.line, category: g.owner.category, total_ms: g.owner.total_ms, calls: g.owner.calls ?? null },
			ms: g.ms,
			pct_busy: round1((g.ms / busy) * 100),
			share_of_owner: g.share,
			functions: g.fns.map((f) => ({ name: f.name, file: f.url, line: f.line, category: f.category, package: f.pkg ?? null, ms: f.ms })),
			tree: g.tree
		})),
		ogygia: (() => {
			const og =
				[...meta.requests]
					.filter((r) => r.og)
					.sort((x, y) => (y.og!.seed_bytes + y.og!.tail_bytes) - (x.og!.seed_bytes + x.og!.tail_bytes))[0]?.og ?? null;
			if (!og) return null;
			const { island_rows, seed, hole_rows, ...totals } = og;
			const client = new Map((extras.client ?? []).map((c) => [c.entry, c]));
			const by_name = new Map(a.components.map((c) => [c.name, c]));
			return {
				// the totals (`islands` / `holes` are COUNTS here; the rows follow)
				...totals,
				// one row per island (fingerprints merged): what it ships, what it costs on the server
				// (its component's SSR time), what it weighs in the browser, and what the browser measured
				island_rows: group_islands(island_rows ?? []).map((r) => {
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
						modules: [r.module_url, ...r.hints].filter(Boolean),
						interactivity: r.interactivity,
						client: cl ? { hydrations: cl.n, p50_ms: cl.p50_ms, max_ms: cl.max_ms, load_p50_ms: cl.load_p50_ms, recovered: cl.recovered, ...(cl.reason ? { reason: cl.reason } : {}) } : null
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
						requests: e ? { hit: e.hit, miss: e.miss, uncached: e.none, avg_ms: round1(e.ms / Math.max(e.hit + e.miss + e.none, 1)) } : null
					};
				})
			};
		})(),
		kit: {
			// the client router's serialization of load data (devalue.uneval under render_response)
			uneval_ms: round1(a.functions.filter((f) => f.pkg === 'devalue' && f.name === 'uneval').reduce((s, f) => s + f.self_ms, 0)),
			etag_ms: round1(a.functions.filter((f) => f.name === 'hash' && f.pkg === '@sveltejs/kit').reduce((s, f) => s + f.self_ms, 0))
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
						// cost of a single render: total ÷ renders (n falls back to 1)
						per_call_ms: round1(c.total_ms / (n ?? 1)),
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
					instances: n,
					file: f.url,
					path: f.path ?? null,
					line: f.line,
					column: f.col || null,
					category: f.category,
					package: f.pkg ?? null,
					self_ms: f.self_ms,
					total_ms: f.total_ms,
					per_call_ms: round1(f.total_ms / (n ?? 1)),
					// the heaviest call paths into it, nearest caller first
					stacks: (f.stacks ?? []).map((s) => ({ ms: s.ms, frames: s.frames.map(frame_text) })),
					// the hot lines inside it (source lines when a sourcemap resolved)
					hot_lines: f.lines ?? null
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
			? { ms: meta.cold.ms, busy_ms: meta.cold.busy_ms, files: cold_rows(a, meta) }
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
										resources: extras.visit.resources.length,
										resource_bytes: extras.visit.resources.reduce((s, r) => s + (r.transfer ?? 0), 0),
										longtasks: extras.visit.longtasks.length,
										islands: extras.visit.islands.map((i) => ({ fp: i.fp, t0: i.t0, loaded: i.loaded, done: i.done, ...(i.changed ? { changed: true } : {}) })),
										firsts: extras.visit.firsts,
										shifts: extras.visit.shifts.length,
										cls_by_island: Object.fromEntries(extras.visit.shifts.reduce((m, s) => m.set(s.fp ?? '(outside islands)', (m.get(s.fp ?? '(outside islands)') ?? 0) + s.value), new Map<string, number>()))
									}
								}
							: {}),
						...(extras.client_cpu
							? {
									cpu: {
										at: extras.client_cpu.at,
										sampled_ms: extras.client_cpu.analysis.duration_ms,
										busy_ms: extras.client_cpu.analysis.busy_ms,
										components: extras.client_cpu.analysis.components.slice(0, 30).map((c) => ({ name: c.name, file: c.url, self_ms: c.self_ms, total_ms: c.total_ms, instances: c.calls ?? null })),
										hot_functions: extras.client_cpu.analysis.functions.slice(0, 30).map((f) => ({ name: f.name, file: f.url, line: f.line, category: f.category, package: f.pkg ?? null, self_ms: f.self_ms, total_ms: f.total_ms }))
									}
								}
							: {})
					}
				: null,
		// a caught request's replay: the link and the inputs it carries
		replay: meta.request ? { url: `${base}/replay/${meta.id}`, path: extras.replay?.path ?? meta.request.path, headers: Object.keys(extras.replay?.headers ?? {}) } : null,
		// the document as a byte strip (page mode): bytes per kind, the segments in order
		strip: extras.strip ? { total: extras.strip.total, by_kind: extras.strip.by_kind, shadow_count: extras.strip.shadow_count, segments: extras.strip.segments } : null,
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
						pauses: extras.gc_attr.pauses.map((p) => ({ t_ms: p.t, ms: p.ms, ms_measured: p.ms_measured, kind: p.kind, forced: p.forced, since_ms: p.since_ms, allocated_bytes: p.allocated, estimated: p.estimated ?? false, why: p.why, running: p.running ?? null, top: p.top.map((x) => ({ name: x.name, component: x.component, bytes: x.bytes, share: x.share })) })),
						makers: extras.gc_attr.makers.slice(0, 40).map((m) => ({ name: m.name, file: m.url, line: m.line, category: m.category, component: m.component, via: m.caller ?? null, allocated_bytes: m.allocated, share: m.share, gc_ms: m.gc_ms, pauses: m.pauses })),
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
		deopts: a.deopts.map((d) => ({ name: d.name, file: d.url, line: d.line, category: d.category, self_ms: d.self_ms, count: d.count, reasons: d.reasons })),
		// synchronous I/O on the CPU inside the window: each one blocked every request on the instance
		sync_io: sync_io(a).map((s) => ({ name: s.name, module: s.module, self_ms: s.self_ms, total_ms: s.total_ms, calls: s.calls, callers: s.callers })),
		// functions called many times per render at a steady cost each: a cache keyed on the argument removes them
		memo_candidates: memo_candidates(a, extras.gc_attr?.makers ?? []),
		// promises created in the window, per render, and who created them (sampled)
		promises: extras.promises ? { count: extras.promises.count, per_render: meta.runs?.length ? Math.round(extras.promises.count / meta.runs.length) : extras.promises.count, top: extras.promises.top } : null,
		// what one more render left alive after a full collection, by allocation site
		retained: extras.retained ? { total_bytes: extras.retained.total_bytes, render_ms: extras.retained.render_ms, sites: extras.retained.sites.map((s) => ({ name: s.name, file: s.url, line: s.line, via: s.caller ?? null, component: s.component, bytes: s.bytes, share: s.share })) } : null,
		// THE RENDER STEP BY STEP: the window's segments in order with running totals and the stack at each
		steps: a.timeline ? (render_steps(a.timeline, a.stacks) ?? null) : null,
		// THE SAMPLES THEMSELVES: every CPU sample of the window with its stack (frames + parent
		// links), the substrate every table above is an aggregate of — query any range or instant
		stacks: a.stacks ? { window_ms: a.stacks.window_ms, raw_samples: a.stacks.raw, frames: a.stacks.frames.map((f) => ({ name: f.n, file: f.f ?? null, category: f.c, parent: f.p })), t_ms: a.stacks.t, d_ms: a.stacks.d, leaf: a.stacks.leaf } : null,
		// WHEN THE HEAP GREW and what ran then: the fine series and its bursts
		alloc: extras.alloc ? { grown_mb: extras.alloc.grown_mb, period_ms: extras.alloc.period_ms, longest_gap_ms: extras.alloc.longest_gap_ms, window: extras.alloc.window ?? null, bursts: extras.alloc.bursts.map((b) => ({ t0_ms: b.t0, t1_ms: b.t1, mb: b.mb, mb_per_s: b.rate, gc_inside: b.gc, running: b.running })), samples: extras.alloc.samples.map((s) => ({ t_ms: s.t, heap_mb: s.mb })) } : null,
		// THE INSTANCE WAS NOT ALONE: the other requests that overlapped the profiled render(s)
		contention: extras.contention ? { overlap_ms: extras.contention.overlap_ms, cpu_max_ms: extras.contention.cpu_max_ms, busy_share: extras.contention.busy_share, inflight_at_start: extras.contention.inflight_at_start, per_window: extras.contention.per_window, requests: extras.contention.requests, note: 'cpu_max_ms is an upper bound: a request’s CPU is a process-wide delta over its lifetime, so overlapping requests carry some of each other’s' } : null,
		// DATA LINEAGE FROM THE CODE: each page.data key with who produced it, who reads it, and a verdict
		lineage: extras.lineage ? { keys: extras.lineage.keys.map((k) => ({ key: k.key, from: k.from, shipped_bytes: k.shipped_bytes, load_wait_ms: k.load_wait_ms, verdict: k.verdict, readers: k.readers })), components: extras.lineage.components, unread: extras.lineage.unread.map((k) => k.key), server_only: extras.lineage.server_only.map((k) => k.key), notes: extras.lineage.notes } : null,
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
