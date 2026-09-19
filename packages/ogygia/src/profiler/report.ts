/**
 * Profiler report DATA: the analyzed profile as curated JSON (`report_json`, the agent view), the
 * dump codec that round-trips a report (`report_dump` / `is_dump`), the findings derivation the UI
 * and the JSON both render from, and the request-log types. The HTML rendering moved to the Svelte
 * components in `./ui/` (rendered through `document()`); this file is pure, testable logic.
 */

import type { Analysis, HeapAllocator } from './analyze.js';
import { sequential_ms, type NetCall } from './net.js';
import { io_kind, type IoOp } from './async-io.js';
import { chain_steps, PHASE_LABEL } from './timeline.js';
import type { HoleRequestStats, IslandStat, OgygiaRequestStats } from '../server/request-stats.js';
import type { SpanRecord } from './span.js';

export type { OgygiaRequestStats, SpanRecord, HoleRequestStats, IslandStat };

/** One span name across a recording: how often, how long, what went wrong, who called it. */
export interface SpanRow {
	name: string;
	count: number;
	total_ms: number;
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
	return [...by.entries()]
		.map(([name, g]) => {
			const done = g.list.filter((s) => !s.open && s.ms >= 0).map((s) => s.ms).sort((a, b) => a - b);
			const hit = g.list.filter((s) => s.attrs?.cache === 'hit').length;
			const miss = g.list.filter((s) => s.attrs?.cache === 'miss');
			const keys = new Set<string>();
			for (const s of g.list) for (const k of Object.keys(s.attrs ?? {})) if (k !== 'cache') keys.add(k);
			return {
				name,
				count: g.list.length,
				total_ms: r2(done.reduce((a, c) => a + c, 0)),
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
	trigger: 'window' | 'page' | 'request';
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
	/** page mode: wall ms of each render run */
	runs?: number[];
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
	/** browser-side hydration timings joined by fingerprint (the runtime's beacon) */
	client?: ClientIslandStat[];
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
		if (per_render >= 5 && ms_per_render >= Math.max(5, window_ms * 0.05)) {
			warn(
				'span-repeat',
				`${s.name} ran ${Math.round(per_render)} times in one render${site}, ${fmt_ms(ms_per_render)} ms together, ${fmt_ms(s.p50_ms)} ms each.`,
				{
					fix: 'Once per item is the N+1 shape: batch it (one call for all the ids), or fetch the parent with its children included.'
				}
			);
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

	if (a.gc_ms > a.busy_ms * 0.15 && a.gc_ms > 5) {
		warn(
			'gc-heavy',
			`Garbage collection took ${fmt_pct(a.gc_ms, a.busy_ms)} of busy time — see the allocators for who creates the garbage.`
		);
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
	for (const e of econ.values()) {
		const total = e.hit + e.miss + e.none;
		if (e.ttl > 0 && total >= 2 && e.hit === 0) {
			warn(
				'hole-cache-cold',
				`Hole ${e.id} has maxAge ${e.ttl}s but its cache never hit in ${total} requests (${fmt_ms(e.ms / total)} ms each).`,
				{ fix: 'The cache key carries the props and the session seal: per-visitor props (a user id, a timestamp) make every key unique. Pass only what the hole renders from.' }
			);
		} else if (e.ttl > 0 && e.hit > 0) {
			info('hole-cache', `Hole ${e.id}: ${e.hit} of ${total} requests served from the render cache (maxAge ${e.ttl}s).`);
		}
	}
	const uncached = rows.filter((h) => h.ttl === 0);
	if (uncached.length && econ.size) {
		const slow = [...econ.values()].filter((e) => e.ttl === 0 && e.ms / Math.max(e.hit + e.miss + e.none, 1) >= 20);
		if (slow.length) {
			info(
				'hole-uncached',
				`${slow.length} hole${slow.length === 1 ? '' : 's'} render${slow.length === 1 ? 's' : ''} fresh on every visit (${names(slow.map((e) => `${e.id} ${fmt_ms(e.ms / Math.max(e.hit + e.miss + e.none, 1))} ms`))}).`,
				{ fix: 'Content that is the same for every visitor for a while can take a maxAge: the endpoint then serves the memo.' }
			);
		}
	}
	// THE BROWSER'S SIDE: hydration timings the runtime beaconed, joined by fingerprint.
	const client = extras.client ?? [];
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

	const alloc_by_name = new Map<string, number>();
	for (const h of extras.heap ?? [])
		alloc_by_name.set(h.name, (alloc_by_name.get(h.name) ?? 0) + h.self_bytes);

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
			request: meta.request ?? null
		},
		summary: {
			window_ms: meta.duration_ms,
			busy_ms: a.busy_ms,
			busy_pct: round1((a.busy_ms / dur) * 100),
			idle_ms: a.idle_ms,
			gc_ms: a.gc_ms,
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
					chain: a.timeline.chain ?? null
				}
			: null,
		// the app's own spans (`span()`), per name: count, total, p50, max, errors, cache tallies, callers
		spans: span_rows(extras.spans),
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
						client: cl ? { hydrations: cl.n, p50_ms: cl.p50_ms, max_ms: cl.max_ms, load_p50_ms: cl.load_p50_ms } : null
					};
				}),
				// the seed explainer names islands already (hooks.ts explain_seed)
				seed: seed ?? null,
				hole_rows: (hole_rows ?? []).map((h) => {
					const e = hole_economics(meta).get(h.id);
					return {
						id: h.id,
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
					stacks: (f.stacks ?? []).map((s) => ({ ms: s.ms, frames: s.frames.map(frame_text) }))
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
					headers: c.headers ?? null,
					error: c.error ?? null
				}))
		},
		memory: {
			rss_start_mb: extras.mem[0]?.rss ?? null,
			rss_end_mb: extras.mem.at(-1)?.rss ?? null,
			growth_mb: extras.mem.length >= 2 ? extras.mem.at(-1)!.rss - extras.mem[0].rss : 0,
			gc: extras.gc ?? null,
			allocators: (extras.heap ?? []).map((h) => ({
				name: h.name,
				file: h.url,
				line: h.line,
				category: h.category,
				self_bytes: h.self_bytes,
				total_bytes: h.total_bytes
			})),
			samples: extras.mem.map((m) => ({ t_ms: m.t, rss_mb: m.rss, heap_used_mb: m.heap_used }))
		},
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
