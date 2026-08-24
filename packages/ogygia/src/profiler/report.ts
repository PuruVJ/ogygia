/**
 * Profiler report DATA: the analyzed profile as curated JSON (`report_json`, the agent view), the
 * dump codec that round-trips a report (`report_dump` / `is_dump`), the findings derivation the UI
 * and the JSON both render from, and the request-log types. The HTML rendering moved to the Svelte
 * components in `./ui/` (rendered through `document()`); this file is pure, testable logic.
 */

import type { Analysis, HeapAllocator } from './analyze.js';
import { sequential_ms, type NetCall } from './net.js';
import { io_kind, type IoOp } from './async-io.js';

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
}

/** The plain-language bottleneck read, as structured data. The HTML verdict and
 * the JSON report both render from this, so they never drift. */
export function derive_findings(a: Analysis, meta: ReportMeta, extras: ReportExtras): Finding[] {
	const out: Finding[] = [];
	const info = (code: string, message: string) => out.push({ severity: 'info', code, message });
	const warn = (code: string, message: string) => out.push({ severity: 'warn', code, message });

	const busy_pct = a.duration_ms > 0 ? (a.busy_ms / a.duration_ms) * 100 : 0;
	const net = extras.net.filter((c) => c.ms >= 0);
	const net_total = net.reduce((s, c) => s + c.ms + (c.body_ms ?? 0), 0);
	const seq = sequential_ms(extras.net);
	const net_errors = extras.net.filter((c) => c.error).length;

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

	if (net.length >= 2 && seq > meta.duration_ms * 0.5 && busy_pct < 60) {
		warn(
			'sequential-network',
			`Network calls ran back-to-back for ${fmt_ms(seq)} ms of the window — usually sequential awaits. Batch them with Promise.all.`
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
	const tc = a.components[0];
	if (tc)
		info(
			'top-component',
			`Most expensive component: ${tc.name} at ${fmt_ms(tc.total_ms)} ms total.`
		);

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

/**
 * The whole profile as one curated JSON object — the agent-facing view. Served
 * at `<base>/report/<id>.json`. Not the raw V8 profile (that is `/raw`): this is
 * already analyzed — self/total per component, network attribution, memory, GC,
 * and the same findings the human report shows.
 */
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
		components: (() => {
			return [...a.components]
				.sort((x, y) => y.self_ms - x.self_ms)
				.map((c) => {
					const n = (c.calls ?? 0) || null;
					return {
						name: c.name,
						instances: n,
						file: c.url,
						line: c.line,
						self_ms: c.self_ms,
						total_ms: c.total_ms,
						// cost of a single render: total ÷ renders (n falls back to 1)
						per_call_ms: round1(c.total_ms / (n ?? 1)),
						pct_busy: round1((c.total_ms / busy) * 100),
						alloc_bytes: alloc_by_name.get(c.name) ?? null
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
					line: f.line,
					category: f.category,
					self_ms: f.self_ms,
					total_ms: f.total_ms,
					per_call_ms: round1(f.total_ms / (n ?? 1))
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
					route: c.route ?? c.path ?? null,
					caller: c.caller ?? null,
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
			internal: !!r.internal
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
