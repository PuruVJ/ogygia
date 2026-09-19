/**
 * The drop-in, production-safe SSR profiler for SvelteKit. Configured ENTIRELY in
 * vite.config.ts — never wired in hooks:
 *
 *     ogygia({ profiler: true })          // or { profiler: { secret, path, … } }
 *
 * `ogygia.handle()` reads that config (through the `virtual:ogygia/profiler-config`
 * module) and dynamically imports + mounts this internally, so hooks.server.ts stays
 * a plain `sequence(...)`. This module is NOT a public entry point — it is reached
 * only through the handle's lazy import.
 *
 * What you get, with zero per-component wrapping:
 *
 * - Always on (free in production): wall time + CPU per request, per-route p50/p95.
 *   Outbound-network attribution and Server-Timing headers are always on in DEV; in
 *   production they exist only while a profile is being recorded (page-mode or the
 *   `x-profile` header) — an idle request runs in no AsyncLocalStorage and pays nothing.
 * - On demand: a V8 sampling CPU profile of the live server. Svelte compiles
 *   every component to a function named after its file, so the profile
 *   attributes SSR time to components by itself.
 * - Network attribution: `fetch` and `http/https` are patched (call-through)
 *   and every outbound call is tied to the request that made it.
 * - Memory: RSS/heap sampling during recordings plus a heap allocation
 *   profile ("who allocates the most").
 *
 * Visit `<path>` (default /__profiler) — in prod, log in (or send the x-profiler-key header).
 * All state lives in memory; nothing is written to disk.
 */

import type { Handle, RequestEvent } from '@sveltejs/kit';
import {
	analyze,
	analyze_heap,
	sourcemap_resolver,
	type Analysis,
	type CpuProfile,
	type HeapAllocator,
	type HeapNode,
	type SourceMapResolver
} from './analyze.js';
import type { CallerSite, NetCall, NetContext } from './net.js';
import type { IoOp } from './async-io.js';
import {
	report_json,
	report_dump,
	is_dump,
	type MemSample,
	type ReportExtras,
	type ReportMeta,
	type RequestEntry,
	type RouteAgg
} from './report.js';
import { ogp_encode, ogp_decode, is_ogp, recover_ogp_bytes } from './crypto.js';
import { derive_findings, island_rows_of, type ClientIslandStat } from './report.js';
import { compare_reports, page_history } from './compare.js';
import { label_call, phase_of_frame } from './timeline.js';
import { io_kind } from './async-io.js';
import { hole_stats_of, request_stats_of, set_request_stats_detail } from '../server/request-stats.js';
import { set_span_recorder, type SpanRecord, type SpanRecorder } from './span.js';
import { register_profiler_file } from './frames.js';

// The span recorder's `begin` lives in this file: skip its frame when finding a span's caller.
register_profiler_file();
import { error, type Router, type Ctx as RouteCtx } from '../router/index.js';
import { is_http_error, is_redirect } from '../router/respond.js';
import { build_profiler_router } from './profiler-router.js';
import { detect_dev } from './env.js';

export interface ProfilerOptions {
	/**
	 * Auth secret. Defaults to the OGYGIA_PROFILER_SECRET env var. Required outside
	 * dev — with no secret in production the profiler UI is disabled (the
	 * always-on request log still collects, invisibly).
	 */
	secret?: string;
	/** Base path for the UI. Default '/__profiler'. */
	path?: string;
	/** Sampling interval in microseconds for recordings. Default 500. */
	sampleInterval?: number;
	/** How many finished profiles to keep in memory (each gzipped). Default 6. */
	maxReports?: number;
	/** How many requests the rolling log keeps. Default 500. */
	recentRequests?: number;
	/**
	 * Patch fetch/http to attribute outbound calls. Default true. In production the
	 * per-request AsyncLocalStorage that does the attributing exists only while a profile
	 * is being recorded (idle requests pay nothing); in dev it is always on. Set false to
	 * skip the global fetch/http patch entirely: wall timing only, never any network view.
	 */
	network?: boolean;
	/**
	 * Add Server-Timing headers to every response. These expose internal render
	 * and network timings to every client, so the default is ON in dev and OFF
	 * in production — set true to force it on.
	 */
	serverTiming?: boolean;
	/** Take a heap allocation profile during recordings. Default true. */
	heap?: boolean;
	/** Master switch. Default true. */
	enabled?: boolean;
}

interface UserTiming {
	name: string;
	count: number;
	total_ms: number;
	max_ms: number;
}

interface GcSummary {
	count: number;
	total_ms: number;
	max_ms: number;
}

export interface StoredReport {
	meta: ReportMeta;
	analysis: Analysis;
	heap: HeapAllocator[] | null;
	net: NetCall[];
	spans?: SpanRecord[];
	mem: MemSample[];
	measures: UserTiming[];
	gc: GcSummary | null;
	io: IoOp[];
	call_counts: Record<string, number>;
	/** the raw .cpuprofile, gzipped — a 10s profile is multiple MB of JSON, so
	 * we keep it compressed (~10×) and inflate only on download */
	raw: Buffer | string;
	/** bytes per island module / preload href (page mode on a built app) */
	weights?: Record<string, number>;
	/** browser hydration timings carried by an uploaded dump (a live report joins the ring instead) */
	client?: ClientIslandStat[];
}

/** One island fingerprint's browser-side samples (the runtime's hydration beacon). */
interface BeaconAgg {
	entry: string;
	/** wake → data-hydrated, ms */
	ms: number[];
	/** the module-load part, ms */
	load: number[];
	last: number;
}
const MAX_BEACON_FPS = 2000;
const MAX_BEACON_SAMPLES = 64;
const MAX_BEACON_BODY = 64 * 1024;
const MAX_BEACON_ISLANDS = 400;
/** the tag the runtime looks for: its content is the beacon endpoint */
const BEACON_META = 'ogygia-profiler-beacon';
const HEAD_CLOSE_RE = /<\/head>/i;

/** GET each URL through the app's own fetch and count its bytes — the JS weight of an island's
 *  closure. Cached per process (immutable hashed assets), a handful at a time, capped in time so
 *  a slow static host can never hold a report hostage. */
async function weigh_urls(
	urls: Iterable<string>,
	fetch_url: (url: string) => Promise<Response>,
	cache: Map<string, number | null>,
	budget_ms = 4000
): Promise<Record<string, number>> {
	const todo = [...new Set(urls)].filter((u) => u && !cache.has(u));
	const deadline = Date.now() + budget_ms;
	let i = 0;
	const worker = async () => {
		while (i < todo.length && Date.now() < deadline) {
			const u = todo[i++];
			try {
				const res = await with_timeout(fetch_url(u), Math.max(200, deadline - Date.now()), 'weigh');
				if (!res.ok) {
					cache.set(u, null);
					continue;
				}
				const len = Number(res.headers.get('content-length'));
				// content-length is the wire size; the body's own length is the decoded size — the
				// bytes the browser parses. Read it when it is not already known to be identity.
				const enc = res.headers.get('content-encoding');
				const bytes = !enc && Number.isFinite(len) && len > 0 ? len : (await res.arrayBuffer()).byteLength;
				cache.set(u, bytes);
			} catch {
				cache.set(u, null);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
	const out: Record<string, number> = {};
	for (const u of new Set(urls)) {
		const b = cache.get(u);
		if (typeof b === 'number') out[u] = b;
	}
	return out;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

function summarize_measures(entries: { name: string; ms: number }[]): UserTiming[] {
	const by_name = new Map<string, UserTiming>();
	for (const e of entries) {
		let t = by_name.get(e.name);
		if (!t) by_name.set(e.name, (t = { name: e.name, count: 0, total_ms: 0, max_ms: 0 }));
		t.count++;
		t.total_ms += e.ms;
		if (e.ms > t.max_ms) t.max_ms = e.ms;
	}
	return [...by_name.values()]
		.map((t) => ({ ...t, total_ms: round2(t.total_ms), max_ms: round2(t.max_ms) }))
		.sort((a, b) => b.total_ms - a.total_ms)
		.slice(0, 30);
}

interface Ctx extends NetContext {
	entry: RequestEntry;
	net: NetCall[];
	/** this request's spans (`span()` from ogygia/profiler), capped like `net` */
	spans: SpanRecord[];
	/** the span the current code runs inside (a child store per `span.within`), for nesting */
	span?: number;
}

const MAX_SPANS_PER_REQUEST = 2000;
const MAX_WINDOW_SPANS = 20_000;
const MAX_TAGS = 16;

interface WindowCapture {
	profile: CpuProfile;
	heap: HeapNode | null;
	mem: MemSample[];
	net: NetCall[];
	/** every span recorded during the window (`span()`), any request */
	spans: SpanRecord[];
	gc_pauses: number[];
	io_ops: IoOp[];
	call_counts: Record<string, number>;
	measures: UserTiming[];
	loop?: { p50: number; p99: number; max: number };
	cpu_percent?: number;
	elu_percent?: number;
	t0: number;
	t1: number;
	duration_ms: number;
	/** performance.now() right after `Profiler.start` — puts the samples on the net/io clock */
	perf_start: number;
	/** the ONE request the report's timeline explains (page mode: the representative run; request
	 *  mode: the request), performance.now() ms; absent for a plain window */
	window?: { start: number; end: number };
}

const MAX_NET_PER_REQUEST = 100;
const MAX_WINDOW_NET = 2000;
const MAX_BACKGROUND_NET = 300;
// A recording that started longer ago than this is treated as abandoned (a frozen/timed-out
// serverless invocation whose cleanup never ran), so the profiler unwedges itself. Kept just above
// the hard cap below so a legit run never trips it, but a truly wedged one self-heals fast — while a
// recording is active EVERY request on the site runs inside the attribution AsyncLocalStorage, so a
// stuck run is a site-wide tax until this elapses.
const RECORDING_MAX_MS = 35_000;
// The absolute wall-time a single page recording may run, even on a real server with no gateway kill.
// A hung upstream on the profiled page must never keep the site-wide attribution context alive: past
// this the run is abandoned, its state cleared, and the request returns. Well above a legit multi-run
// recording (5 renders of a 3 s page + coverage ≈ 20 s); on serverless the platform budget is smaller
// and wins.
const RECORDING_HARD_CAP_MS = 30_000;
// One render (a warm-up hop or a run) that outlives this is treated as hung: the recording stops
// waiting on it and finishes with what it has, rather than pinning the whole recording — and the site —
// on a page whose own upstream never returns.
const PER_RENDER_TIMEOUT_MS = 15_000;
// Recordings SERIALIZE PER WORKER — the V8 inspector CPU/heap sampler and the attribution
// AsyncLocalStorage are both process-global, so two at once on one process would cross-pollute each
// other's samples. There is deliberately NO in-memory server queue: on serverless a worker is recycled
// within ~30 s (memory wiped), so a parked waiter is unreliable — and unnecessary, because a retry
// lands on a different, free worker. When a worker is busy it returns 409 immediately and the CLIENT
// polls (RunView) until some worker says yes. That "queue" needs no shared storage, so it works the
// same on Amplify (isolated workers) and on a single long-lived server.
/** an inspector-unavailable recording error (edge runtimes) vs a real profiling failure */
const INSPECTOR_ERR = /inspector/;
const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const QUERY_SUFFIX_RE = /\?.*$/;
const SRC_RELATIVE_RE = /(?:^|[/\\])src[/\\](.*)$/;
const BACKSLASH_G = /\\/g;
const PATH_SEP_RE = /[/\\]/;
const TRAILING_SLASH_RE = /\/$/;
/** a WebAssembly script "file" as V8 names it: `/wasm/00034eea`, `wasm://wasm/…` */
const WASM_FRAME_RE = /^(?:wasm:\/\/|\/wasm\/)|[/\\]wasm\/[0-9a-f]+$/;
/** a Kit endpoint file in a resolved caller string (`+server.ts`, or its built `_server.ts.js`) */
const SERVER_ROUTE_FILE_RE = /[/\\](?:\+server\.[jt]s|_server\.[jt]s\.js):\d+/;
/** the file inside a resolved caller string: `name (file:line)` or `file:line` */
const CALLER_FILE_RE = /(?:\(|^)([^()]+):\d+\)?$/;
/** what the dev source peek may read */
const SOURCE_EXT_RE = /\.(?:svelte|ts|js|mjs|cjs|tsx|jsx|svx|md|json)$/;

// Serverless page-profile budget. On a managed host the whole `/page` request must return before the
// platform's gateway kills it, so we cap all profiling work (warm-up + CPU runs + coverage pass) and
// keep the rest of the budget for analysis + serialization + response.
//
// NONE of these platforms expose their function timeout as a runtime env var (checked Aug 2026:
// Vercel's full system-env list, Amplify, Netlify) — it's build-time / gateway config — so we DETECT
// the platform and use its binding timeout, and honour OGYGIA_PROFILER_BUDGET_MS when the author has
// raised or lowered maxDuration from the default.
const SERVERLESS_RESERVE_MS = 5_000; // analysis + report build + .ogp/json serialize + jitter
/** The whole-request wall budget (ms) before the platform's gateway kills a /page profile — Infinity
 *  on a real server (adapter-node, dev). An explicit OGYGIA_PROFILER_BUDGET_MS wins over detection. */
function detect_request_budget_ms(): number {
	const override = Number(process.env.OGYGIA_PROFILER_BUDGET_MS);
	if (Number.isFinite(override) && override > 0) return override;
	const env = process.env;
	// Vercel + Netlify BOTH run on Lambda (AWS_LAMBDA_FUNCTION_NAME set), so check them FIRST.
	if (env.VERCEL) return 300_000; // Vercel Functions: 300s default (fluid); Pro/Ent max 800s
	if (env.NETLIFY) return 10_000; // Netlify Functions: 10s synchronous default (max 26s)
	// AWS Amplify (WEB_COMPUTE SSR) → CloudFront 30s origin timeout; also the generic Lambda + API GW cap.
	if (env.AWS_LAMBDA_FUNCTION_NAME || env.LAMBDA_TASK_ROOT) return 30_000;
	return Infinity; // a real server — no gateway kill
}
/** Time allotted to the profiling work itself (warm-up + runs + coverage), keeping RESERVE for the
 *  rest of the request. Halves as a floor so a very small budget still spends most of itself working. */
function serverless_work_budget_ms(): number {
	const req = detect_request_budget_ms();
	if (!Number.isFinite(req)) return Infinity;
	return Math.max(req - SERVERLESS_RESERVE_MS, Math.floor(req * 0.5));
}

type HashFn = (algo: string) => { update(s: string): { digest(enc: 'hex'): string } };

/**
 * Page mode renders the SAME page N times, so its outbound calls are the same handful repeated N
 * times — a waterfall of 5×3 identical bars is noise. Given each run's [start,end] window, keep only
 * ONE representative render's net + io (the run that captured the most calls — the fullest picture;
 * ties go to the later, warmer run) so the network view reads as "one request + its leaf calls". CPU
 * stays merged across all runs (more samples = steadier median); network is inherently per-render.
 */
function scope_net_to_one_run(
	cap: { net: NetCall[]; io_ops: IoOp[] },
	windows: Array<{ start: number; end: number }>
): { start: number; end: number } | null {
	if (windows.length <= 1) return windows[0] ?? null;
	const within = (t: number, w: { start: number; end: number }) => t >= w.start && t <= w.end;
	let best = windows[0];
	let best_n = -1;
	for (const w of windows) {
		const n = cap.net.reduce((s, c) => s + (within(c.start, w) ? 1 : 0), 0);
		if (n >= best_n) {
			best_n = n;
			best = w;
		}
	}
	cap.net = cap.net.filter((c) => within(c.start, best));
	cap.io_ops = cap.io_ops.filter((o) => within(o.start, best));
	return best;
}

/**
 * The profiler as a class — state lives in fields, not closures, matching the
 * `OgygiaHandle` house style. `profiler(options)` (below) constructs one and
 * returns its bound `handle`.
 */
class Profiler {
	readonly base: string;
	readonly sample_interval: number;
	readonly max_reports: number;
	readonly ring_size: number;
	readonly want_network: boolean;
	readonly want_heap: boolean;
	readonly dev: boolean;
	readonly want_server_timing: boolean;
	readonly secret: string;
	readonly ui_enabled: boolean;
	readonly #disabled: boolean;

	// ---- state ------------------------------------------------------------
	readonly #ring: RequestEntry[] = [];
	readonly #reports = new Map<string, StoredReport>();
	/** the browser's hydration timings, by island fingerprint (`/beacon`) — joined into reports at view time */
	readonly #beacons = new Map<string, BeaconAgg>();
	/** bytes per asset URL, measured once per process */
	readonly #weights = new Map<string, number | null>();
	readonly #background_net: NetCall[] = [];
	#window_net: NetCall[] | null = null;
	#inflight = 0;
	// Epoch-ms a recording began, or 0. A TIMESTAMP (not a boolean) so a stuck run self-heals: on a
	// serverless host (Amplify/Lambda) the process can freeze or time out mid-profile and the `finally`
	// that clears it never runs — leaving a boolean flag `true` forever, which is exactly the "previous
	// session is still running, can't profile again" bug. Past RECORDING_MAX_MS a stale run is ignored.
	#recording_since = 0;
	// The recorder lock: held for the life of a recording (the inspector session is only free once it
	// ends), independent of `#recording_since` (which the watchdog may clear earlier to unblock the site).
	// Non-blocking — a second recording on the same worker is refused, not queued (the client retries onto
	// another worker). See #try_acquire_recorder.
	#recorder_busy = false;
	#als: import('node:async_hooks').AsyncLocalStorage<Ctx> | null = null;
	#init_done: Promise<void> | null = null;
	/** Re-assert the `globalThis.fetch` patch before a profile (self-heal if it was replaced). */
	#ensure_net: (() => void) | null = null;

	constructor(options: ProfilerOptions = {}) {
		this.base = options.path ?? '/__profiler';
		this.sample_interval = clamp(options.sampleInterval ?? 500, 50, 10_000);
		this.max_reports = options.maxReports ?? 6;
		this.ring_size = options.recentRequests ?? 500;
		this.want_network = options.network !== false;
		this.want_heap = options.heap !== false;
		this.dev = detect_dev(); // replaced by Vite when the app is built; falls back to NODE_ENV
		// Server-Timing exposes internal render/network timings to every client, so
		// default it ON in dev but OFF in production unless explicitly enabled.
		this.want_server_timing = options.serverTiming ?? this.dev;
		this.secret = options.secret ?? process.env.OGYGIA_PROFILER_SECRET ?? '';
		this.ui_enabled = options.enabled !== false && (this.dev || this.secret !== '');
		this.#disabled = options.enabled === false;
	}

	#collect_window(call: NetCall): void {
		if (this.#window_net && this.#window_net.length < MAX_WINDOW_NET) this.#window_net.push(call);
	}

	#init(): Promise<void> {
		return (this.#init_done ??= (async () => {
			// AsyncLocalStorage + the fetch/http patch exist ONLY to attribute
			// outbound calls. With network capture off there is no per-request work
			// beyond wall timing — the honest "near-zero when off" path.
			if (!this.want_network) return;
			try {
				const { AsyncLocalStorage } = await import('node:async_hooks');
				this.#als = new AsyncLocalStorage<Ctx>();
			} catch {
				this.#als = null;
			}
			if (this.#als) {
				try {
					const { install_net_capture, ensure_fetch_patched } = await import('./net.js');
					await install_net_capture(this.#als, (call) => {
						this.#collect_window(call);
						this.#background_net.push(call);
						if (this.#background_net.length > MAX_BACKGROUND_NET) this.#background_net.shift();
					});
					// Kept so every profile can re-assert the patch — `globalThis.fetch` may have been
					// replaced since install (late undici init / a polyfill / HMR), which silently drops
					// capture. This is what makes a run RELIABLY see network instead of sometimes.
					this.#ensure_net = ensure_fetch_patched;
				} catch {
					// platform without patchable modules — wall timing still works
				}
			}
		})());
	}

	// ---- recording --------------------------------------------------------
	/** A recording is "active" only if one started recently — a run abandoned by a frozen/killed
	 *  serverless invocation ages out after the cap instead of wedging the profiler forever. */
	#recording_active(): boolean {
		return this.#recording_since > 0 && Date.now() - this.#recording_since < RECORDING_MAX_MS;
	}

	/** Take the recorder slot without waiting: true if it was free (now ours), false if busy. Recordings
	 *  serialize PER WORKER — one V8 inspector CPU/heap sampler + one attribution context per process — so
	 *  a second recording on the same process is refused, NOT queued in memory: on serverless the process
	 *  can be recycled at any moment (Amplify freezes a worker after ~30 s), so a waiter parked in memory
	 *  is unreliable, and it isn't needed — a retry lands on a different, free worker. The "queue" is the
	 *  CLIENT polling `/page` until a worker says yes (see RunView). */
	#try_acquire_recorder(): boolean {
		if (this.#recorder_busy) return false;
		this.#recorder_busy = true;
		return true;
	}

	/** Free the recorder slot. Called only when the recording is truly finished (its inspector session
	 *  closed) — never from the site-unblock watchdog, which may fire while an orphaned run still holds
	 *  the inspector. */
	#release_recorder(): void {
		this.#recorder_busy = false;
	}

	/** Production: detach the profiler's AsyncLocalStorage once a recording ends. An ALS that has
	 *  run once stays enabled — every async hop in the process keeps paying a store copy for it — until
	 *  `disable()`; the next `run()` re-enables it. Dev keeps it on (attribution is always on there). */
	#release_als(): void {
		if (!this.dev) this.#als?.disable();
	}

	async #capture_window(interval_us: number, work: () => Promise<void>): Promise<WindowCapture> {
		const { Session } = await import('node:inspector/promises');
		const perf_hooks = await import('node:perf_hooks');

		const session = new Session();
		session.connect();
		const histogram = perf_hooks.monitorEventLoopDelay({ resolution: 10 });
		histogram.enable();
		const elu0 = perf_hooks.performance.eventLoopUtilization();
		const cpu0 = process.cpuUsage();

		// PerformanceObserver complements the sampler: precise GC pause durations
		// (the sampler only estimates GC), and any performance.measure() spans the
		// app or its libraries already emit (DB drivers, OpenTelemetry, SvelteKit's
		// experimental tracing) — collected for free, shown only when present.
		const gc_pauses: number[] = [];
		const measures: { name: string; ms: number }[] = [];
		const ingest = (
			entries: ReadonlyArray<{ entryType: string; name: string; duration: number }>
		) => {
			for (const e of entries) {
				if (e.entryType === 'gc') gc_pauses.push(e.duration);
				else if (e.entryType === 'measure' && measures.length < 5000) {
					measures.push({ name: e.name, ms: e.duration });
				}
			}
		};
		let observer: import('node:perf_hooks').PerformanceObserver | undefined;
		try {
			observer = new perf_hooks.PerformanceObserver((list) => ingest(list.getEntries()));
			observer.observe({ entryTypes: ['gc', 'measure'] });
		} catch {
			// entry types unavailable on this runtime — sampler still covers GC
		}

		const mem: MemSample[] = [];
		const t0 = Date.now();
		const sample_mem = () => {
			const m = process.memoryUsage();
			mem.push({
				t: Date.now() - t0,
				rss: Math.round(m.rss / 1048576),
				heap_used: Math.round(m.heapUsed / 1048576)
			});
		};
		sample_mem();
		const mem_timer = setInterval(sample_mem, 250);
		mem_timer.unref?.();

		this.#window_net = [];
		// capture the calling stack of each outbound I/O call for the duration of
		// the window (off otherwise — it costs a stack per call)
		const netmod = await import('./net.js').catch(() => null);
		netmod?.set_stack_capture(true);
		// SPANS (`span()` / `tag()` from ogygia/profiler): recorded only while this window runs.
		// A span rides the same async context as the fetch patch — the request it belongs to, and
		// for nesting a child store carrying the span's id (only during a recording, so the per-hop
		// cost of a second store never reaches an un-profiled request).
		const spans: SpanRecord[] = [];
		let span_seq = 0;
		const als = this.#als;
		const span_recorder: SpanRecorder = {
			begin: (name, attrs) => {
				const ctx = als?.getStore();
				const rec: SpanRecord = {
					id: ++span_seq,
					name: String(name).slice(0, 120),
					start: perf_hooks.performance.now(),
					ms: -1,
					...(attrs ? { attrs: { ...attrs } } : {}),
					...(ctx?.span !== undefined ? { parent: ctx.span } : {}),
					caller_site: netmod?.nearest_app_site(),
					route: ctx?.route ?? null,
					path: ctx?.path ?? null
				};
				if (spans.length < MAX_WINDOW_SPANS) spans.push(rec);
				if (ctx && ctx.spans.length < MAX_SPANS_PER_REQUEST) ctx.spans.push(rec);
				return rec;
			},
			within: (s, fn) => {
				const ctx = als?.getStore();
				return ctx && als ? als.run({ ...ctx, span: s.id }, fn) : fn();
			},
			end: (s, attrs, error) => {
				s.ms = round2(perf_hooks.performance.now() - s.start);
				if (attrs) s.attrs = { ...s.attrs, ...attrs };
				if (error !== undefined) {
					s.error = error instanceof Error ? error.message : String(error);
				}
			},
			tag: (key, value) => {
				const ctx = als?.getStore();
				if (!ctx) return;
				const tags = (ctx.entry.tags ??= {});
				if (key in tags || Object.keys(tags).length < MAX_TAGS) tags[key] = value;
			}
		};
		set_span_recorder(span_recorder);
		// DETAIL from ogygia's handle (per-island rows, the seed explainer, hole notes) costs a little
		// per region — asked for only while this window records (server/request-stats.ts).
		set_request_stats_detail(true);
		const iomod = await import('./async-io.js').catch(() => null);
		let io_rec = iomod ? await iomod.record_async_io() : null;

		let heap_head: HeapNode | null = null;
		try {
			await session.post('Profiler.enable');
			await session.post('Profiler.setSamplingInterval', { interval: interval_us });
			if (this.want_heap) {
				try {
					await session.post('HeapProfiler.enable');
					await session.post('HeapProfiler.startSampling', { samplingInterval: 16384 });
				} catch {
					// heap sampling unsupported — carry on
				}
			}
			// The samples' clock: V8 stamps the profile's `startTime` when the profile is created, at
			// the START of this call — then scans every compiled function before the call returns
			// (tens of ms on a big heap). Taking the mark BEFORE the post keeps the samples on the
			// net/io clock; taken after, every CPU sample landed that scan-time late on the timeline.
			const perf_start = perf_hooks.performance.now();
			await session.post('Profiler.start');

			await work();

			const { profile } = await session.post('Profiler.stop');
			if (this.want_heap) {
				try {
					const res = await session.post('HeapProfiler.stopSampling');
					heap_head = (res as { profile?: { head?: HeapNode } }).profile?.head ?? null;
				} catch {
					heap_head = null;
				}
			}
			const t1 = Date.now();
			sample_mem();
			// drain entries the observer buffered but hasn't delivered to its
			// callback yet (deferred batching would otherwise lose the last GCs)
			try {
				if (observer) ingest(observer.takeRecords());
			} catch {
				// takeRecords unsupported — callback-delivered entries still counted
			}

			const cpu = process.cpuUsage(cpu0);
			const elu = perf_hooks.performance.eventLoopUtilization(elu0);
			const duration_ms = t1 - t0;
			const net = this.#window_net ?? [];

			// a span never ended before the window closed stays `open` (a hung driver call, a
			// handle the app forgot) — reported as such, never timed as if it had finished
			for (const s of spans) if (s.ms < 0) s.open = true;
			return {
				profile: profile as CpuProfile,
				heap: heap_head,
				mem,
				net,
				spans,
				gc_pauses,
				io_ops: io_rec ? io_rec.stop() : [],
				call_counts: {},
				measures: summarize_measures(measures),
				loop: {
					p50: round2(histogram.percentile(50) / 1e6),
					p99: round2(histogram.percentile(99) / 1e6),
					max: round2(histogram.max / 1e6)
				},
				cpu_percent:
					duration_ms > 0
						? round2(((cpu.user + cpu.system) / 1000 / duration_ms) * 100)
						: undefined,
				elu_percent: round2(elu.utilization * 100),
				t0,
				t1,
				duration_ms,
				perf_start
			};
		} finally {
			clearInterval(mem_timer);
			histogram.disable();
			set_span_recorder(null);
			set_request_stats_detail(false);
			netmod?.set_stack_capture(false);
			io_rec?.stop();
			try {
				observer?.disconnect();
			} catch {
				// already gone
			}
			this.#window_net = null;
			try {
				session.disconnect();
			} catch {
				// already gone
			}
		}
	}

	/**
	 * Exact per-function call counts (the ×N), from V8 precise coverage. Run as
	 * its OWN render, not during the CPU sampling window — coverage disables
	 * inlining, so mixing it into the sampled profile makes tiny hot functions
	 * (svelte's `child`, `push`) look like the bottleneck. Counts are per this
	 * single render.
	 */
	async #count_calls(work: () => Promise<void>): Promise<Record<string, number>> {
		const counts: Record<string, number> = {};
		try {
			const { Session } = await import('node:inspector/promises');
			const session = new Session();
			session.connect();
			try {
				await session.post('Profiler.enable');
				await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
				await work();
				const cov = (await session.post('Profiler.takePreciseCoverage')) as {
					result: Array<{
						url: string;
						functions: Array<{ functionName: string; ranges: Array<{ count: number }> }>;
					}>;
				};
				await session.post('Profiler.stopPreciseCoverage');
				// Key by name AND script url: many scripts have a `traverse`/`update`/etc., and merging them
				// by bare name gave every same-named frame the SUMMED total. `<name>\0<url>` is the same
				// identity analyze() joins on (a CPU frame's raw functionName + url), so each function keeps
				// its own count. Anonymous (`(anonymous)`, empty) frames are skipped — components attach via
				// their named wrapper.
				for (const script of cov.result) {
					for (const fn of script.functions) {
						const nm = fn.functionName;
						if (!nm || nm.startsWith('(')) continue;
						const c = fn.ranges[0]?.count ?? 0;
						if (c > 0) {
							const k = nm + '\0' + script.url;
							counts[k] = (counts[k] ?? 0) + c;
						}
					}
				}
			} finally {
				session.disconnect();
			}
		} catch {
			// no inspector / coverage — counts just won't show
		}
		return counts;
	}

	async #make_resolver(): Promise<SourceMapResolver | undefined> {
		try {
			const fs = await import('node:fs');
			const path = await import('node:path');
			// Frame urls are not always absolute: a host that re-bundles the adapter output as CJS
			// (Lambda / Amplify) hands V8 script names RELATIVE to the bundle dir ('./chunks/x.js').
			// A bare readFileSync resolves those against the process CWD — usually NOT the bundle dir
			// on such hosts — so every map lookup missed and `where` stayed at bundled positions even
			// with .map files shipped. Try the entry script's dir (and its parent) before cwd; the
			// resolver caches per chunk, so the extra attempts cost once per file.
			const entry = process.argv[1] ? path.dirname(process.argv[1]) : undefined;
			const bases = entry ? [entry, path.dirname(entry), '.'] : ['.'];
			const is_abs = (p: string) => p.startsWith('/') || WIN_DRIVE_RE.test(p);
			return sourcemap_resolver((p) => {
				for (const base of is_abs(p) ? [''] : bases) {
					try {
						return fs.readFileSync(base ? path.join(base, p) : p, 'utf8');
					} catch {
						/* try the next base */
					}
				}
				return undefined;
			});
		} catch {
			return undefined;
		}
	}

	async #finish_report(
		cap: WindowCapture,
		meta_partial: Pick<
			ReportMeta,
			| 'trigger'
			| 'page'
			| 'runs'
			| 'request'
			| 'redirected_from'
			| 'warmup_ms'
			| 'run_status'
			| 'run_bytes'
			| 'budget_note'
		>,
		/** page mode on a built app: the app's own fetch, to weigh the islands' JS closures */
		fetch_url?: (url: string) => Promise<Response>
	): Promise<string> {
		const resolver = await this.#make_resolver();
		const heap = cap.heap ? analyze_heap(cap.heap) : null;
		// resolve each I/O caller's bundled location back to source, using the same
		// sourcemap resolver the CPU frames use — turns `_page.server.ts.js:8` into
		// `routes/mixed/+page.server.ts:10`, and drops the bundler's chained names.
		// Keep the path relative to `src/` (not just the basename) — `+page.server.ts`
		// alone is ambiguous when many routes have one.
		const rel_src = (f: string) => {
			const clean = f.replace(QUERY_SUFFIX_RE, '');
			const m = SRC_RELATIVE_RE.exec(clean);
			if (m) return m[1].replace(BACKSLASH_G, '/');
			return clean.split(PATH_SEP_RE).slice(-3).join('/');
		};
		const resolve_caller = (site?: CallerSite): string | undefined => {
			if (!site) return undefined;
			const name =
				site.fn && site.fn !== '(anonymous)' && !site.fn.includes('.') ? site.fn : undefined;
			let file = rel_src(site.file);
			let line = site.line;
			const m = resolver?.resolve(
				site.file,
				Math.max(0, site.line - 1),
				Math.max(0, site.column - 1)
			);
			if (m) {
				file = rel_src(m.source);
				line = m.line;
			}
			// a caller that maps back into the profiler is our own I/O (the mem
			// sampler's timer) — drop it, it is not the app's wait
			if (file.startsWith('profiler/') || file.includes('/profiler/')) return undefined;
			// a WebAssembly frame is a library's internals — undici's HTTP parser (llhttp) is the
			// usual one: the zlib stream inflating a gzip response, a socket timer — never the app's
			// own wait. Unattributed, like the runtime's own resources.
			if (WASM_FRAME_RE.test(file)) return undefined;
			return name ? `${name} (${file}:${line})` : `${file}:${line}`;
		};
		for (const c of cap.net) {
			c.caller = resolve_caller(c.caller_site) ?? c.caller;
			delete c.caller_site;
		}
		for (const o of cap.io_ops) {
			o.caller = resolve_caller(o.caller_site);
			delete o.caller_site;
		}
		for (const s of cap.spans) {
			s.caller = resolve_caller(s.caller_site);
			delete s.caller_site;
		}
		// THE TIMELINE INPUT: the one request's window + every call it waited on (net + the I/O
		// primitives the hooks timed, minus the ones still open) — analyze puts the CPU samples on
		// the same clock and walks the critical path (timeline.ts).
		const timeline_input = cap.window ? this.#timeline_input(cap) : undefined;
		const analysis = analyze(cap.profile, resolver, cap.call_counts, timeline_input);
		const id = Math.random().toString(36).slice(2, 10);
		const requests = this.#ring.filter((e) => e.ts + e.ms >= cap.t0 && e.ts <= cap.t1);
		const meta: ReportMeta = {
			id,
			created: cap.t0,
			duration_ms: round2(cap.duration_ms),
			sample_interval_us: this.sample_interval,
			requests,
			loop_delay: cap.loop,
			cpu_percent: cap.cpu_percent,
			elu_percent: cap.elu_percent,
			rss_mb: cap.mem.at(-1)?.rss,
			node: process.version,
			dev: this.dev || undefined,
			...meta_partial
		};
		const gc: GcSummary | null = cap.gc_pauses.length
			? {
					count: cap.gc_pauses.length,
					total_ms: round2(cap.gc_pauses.reduce((a, c) => a + c, 0)),
					max_ms: round2(Math.max(...cap.gc_pauses))
				}
			: null;
		const raw_json = JSON.stringify(cap.profile);
		let raw: Buffer | string = raw_json;
		try {
			const { gzipSync } = await import('node:zlib');
			raw = gzipSync(raw_json);
		} catch {
			// no zlib (unlikely) — keep the string
		}
		// THE ISLANDS' JS WEIGHT: every module / preload href the page's islands pull, fetched once
		// through the app (a built app's hashed assets; dev URLs are unbundled and say nothing).
		let weights: Record<string, number> | undefined;
		if (fetch_url && !this.dev) {
			const urls: string[] = [];
			for (const r of island_rows_of(meta)) urls.push(r.module_url, ...r.hints);
			if (urls.length) weights = await weigh_urls(urls, fetch_url, this.#weights);
		}
		this.#reports.set(id, {
			meta,
			analysis,
			heap,
			net: cap.net,
			spans: cap.spans,
			mem: cap.mem,
			measures: cap.measures,
			gc,
			io: cap.io_ops,
			call_counts: cap.call_counts,
			raw,
			...(weights ? { weights } : {})
		});
		while (this.#reports.size > this.max_reports) {
			const oldest = this.#reports.keys().next().value;
			if (oldest === undefined) break;
			this.#reports.delete(oldest);
		}
		return id;
	}

	// ---- auth -------------------------------------------------------------
	async #key_matches(provided: string | null | undefined): Promise<boolean> {
		if (this.dev) return true;
		if (!this.secret || !provided) return false;
		try {
			const { createHash, timingSafeEqual } = await import('node:crypto');
			const h = (str: string) => createHash('sha256').update(str).digest();
			return (
				timingSafeEqual(h(provided), h(this.secret)) ||
				timingSafeEqual(h(provided), h(this.#cookie_token(createHash)))
			);
		} catch {
			return provided === this.secret;
		}
	}

	#cookie_token(createHash: HashFn): string {
		return createHash('sha256')
			.update('og-profiler:' + this.secret)
			.digest('hex');
	}

	/** Cookie header that starts / clears a profiler session (Set-Cookie value). */
	#session_cookie(token: string, event: RequestEvent): string {
		const secure = event.url.protocol === 'https:' ? '; Secure' : '';
		const clear = token === '' ? '; Max-Age=0' : '';
		return `og_profiler=${token}; Path=${this.base}; HttpOnly; SameSite=Strict${secure}${clear}`;
	}

	/** The BEACON FLAG: a second cookie, site-wide, carrying no secret — it only tells the handle
	 *  "this browser is the profiler's user, put the beacon tag in its documents". The session
	 *  cookie stays scoped to the profiler's own path (the `/beacon` POST is under it, so the
	 *  runtime's post still carries the real session). Set with the session, cleared with it. */
	#beacon_cookie(on: boolean, event: RequestEvent): string {
		const secure = event.url.protocol === 'https:' ? '; Secure' : '';
		return `og_profiler_beacon=${on ? '1' : ''}; Path=/; HttpOnly; SameSite=Lax${secure}${on ? '' : '; Max-Age=0'}`;
	}

	/**
	 * Validate + set up a session. The unlock page POSTs the key here; a match sets the session cookie
	 * and returns to `next`. No HTTP Basic dialog — a plain form + cookie, so the `Authorization` header
	 * is never spent on profiler auth (it stays free, and there's a real Logout).
	 */
	async #login(ctx: RouteCtx): Promise<Response> {
		const body = (await ctx.request.json().catch(() => null)) as {
			key?: unknown;
			next?: unknown;
		} | null;
		const key = String(body?.key ?? '');
		const next = this.#safe_next(String(body?.next ?? this.base)); // no open redirect
		if (!(await this.#key_matches(key))) return ctx.json({ ok: false }, { status: 401 });
		const { createHash } = await import('node:crypto');
		const res = ctx.json({ ok: true, next });
		res.headers.append(
			'set-cookie',
			this.#session_cookie(this.#cookie_token(createHash), ctx.event!)
		);
		res.headers.append('set-cookie', this.#beacon_cookie(true, ctx.event!));
		return res;
	}

	/** false = denied; true = authed; string = authed AND set this cookie */
	async #authed(event: RequestEvent): Promise<boolean> {
		if (!this.ui_enabled) return false;
		if (this.dev) return true;
		// The session cookie (set by the login page) is the browser path; the `x-profiler-key` header is
		// the programmatic path (CI / the MCP tools). No `?key=` — a secret in a URL gets logged & cached.
		const provided =
			event.cookies.get('og_profiler') ?? event.request.headers.get('x-profiler-key');
		return this.#key_matches(provided);
	}

	// ---- profiler UI: an ogygia/router handler-mode dogfood ---------------
	// The gate does AUTH ONLY — no rendering. /login + /logout manage the session and are always
	// reachable; everything else needs a valid session (dev = open). Every page below is a `view()` the
	// router renders through document(); the profiler itself never touches document/region.
	// Auth is a router GUARD now (#auth_guard); nothing to gate here — just dispatch under the base.
	async #ui(event: RequestEvent): Promise<Response> {
		return (
			(await this.#router().fetch(event.request, event)) ??
			new Response('Not found', { status: 404 })
		);
	}

	// Auth as a router guard (a pure pre-check): /login + /logout are always reachable (they manage the
	// session); everything else needs a valid session (dev = open; no-secret prod = hidden → 404). No
	// `?key=` (a key in a URL gets logged/cached/shared) — the browser uses the login cookie, and
	// programmatic access uses the `x-profiler-key` header. The /login POST seats the cookie; this guard
	// never touches the response.
	async #auth_guard(ctx: RouteCtx): Promise<Response | undefined> {
		const rel = ctx.url.pathname.slice(this.base.length).replace(TRAILING_SLASH_RE, '') || '/';
		// `/login` + `/logout` manage the session. The BARE report page (`/report/<id>`, no `.json`/
		// `.dump`/`/raw` suffix) is PUBLIC: a recipient with a share link renders it entirely client-side
		// from the URL `#fragment` (no account). Its SERVER data is still gated — the page's own load
		// only returns a stored report when `authed()`, so an unauth visitor can't read reports by
		// guessing the short id, and the suffixed data endpoints stay behind auth below.
		if (rel === '/login' || rel === '/logout' || /^\/report\/[^/.]+$/.test(rel)) return;
		if (await this.#authed(ctx.event!)) return; // allow
		if (this.ui_enabled && this.secret && !this.dev) {
			const next = encodeURIComponent(ctx.url.pathname + ctx.url.search);
			return ctx.redirect(`${this.base}/login?next=${next}`);
		}
		return new Response('Not found', { status: 404 });
	}

	// The profiler route tree. Built once. Auth is a top layer `load` (Kit-idiomatic — a redirect/404
	// from the load short-circuits every page below it); `/login` + `/logout` exempt themselves inside
	// it. Each page endpoint returns a `view()` the router renders through document(); method routing
	// rides `.get(...).post(...)` on /login and /view. `base` makes patterns base-relative; `miss` gives
	// the profiler its own 404 for anything else under the base.
	#routes: Router | undefined;
	#router(): Router {
		// The route tree lives in profiler-router.ts (so its $infer type is importable by the UI); the
		// host just supplies the handlers as a typed Deps boundary.
		return (this.#routes ??= build_profiler_router({
			base: this.base,
			auth_guard: (c) => this.#auth_guard(c),
			authed: (c) => this.#authed((c as { event?: RequestEvent }).event!),
			beacon: (c) => this.#beacon(c),
			dashboard: (c) => this.#dashboard(c.url.searchParams.get('by')),
			run_page: (c) => this.#run_page(c),
			record_page: (c) => this.#record_page(c),
			reset: (c) => this.#reset(c),
			login_props: (c) => ({
				base: this.base,
				next: this.#safe_next(c.url.searchParams.get('next'))
			}),
			login: (c) => this.#login(c),
			logout: (c) => this.#logout(c),
			upload: (c) => this.#upload(c),
			report_stored: (id) => this.#reports.get(id ?? ''),
			login_url: (c) =>
				this.ui_enabled && this.secret && !this.dev
					? `${this.base}/login?next=${encodeURIComponent(c.url.pathname)}`
					: null,
			report_view: (stored) => this.#report_view(stored),
			report_json: (stored) => this.#report_json(stored),
			report_dump_json: (stored) => this.#report_dump_json(stored),
			report_html: (stored, c) => this.#report_html(stored, c),
			report_raw: (stored) => this.#report_raw(stored),
			compare: (a, b) => this.#compare(a, b),
			source: (c) => this.#source(c)
		}) as Router);
	}

	/**
	 * THE TIMELINE INPUT: the one request's window + every call it waited on. Net calls as they
	 * are. I/O primitives only when they are the app's own wait — the same rule as the "Waiting by
	 * function" table: the op must have a resolved app caller (an unattributed one is undici's
	 * socket timer, a response compressor's zlib stream, the recorder's own timer; a WASM caller
	 * is a library's internals) — and an op that sits inside a net call's span is the other end of
	 * that same call (an in-process API's timer on a self-fetch); the net call already says it.
	 * Each call carries the phase of the code that started it, from the caller's file.
	 */
	#timeline_input(cap: WindowCapture) {
		const w = cap.window!;
		const phase_of = (caller?: string) => {
			const m = caller ? CALLER_FILE_RE.exec(caller) : null;
			return m ? (phase_of_frame({ name: '', url: m[1], line: 0, category: 'app' }) ?? undefined) : undefined;
		};
		const net = cap.net
			.filter((c) => c.ms >= 0)
			.map((c) => ({ start: c.start, end: c.start + c.ms + (c.body_ms ?? 0), c }));
		const inside_a_call = (s: number, e: number) =>
			net.some((n) => s >= n.start - 2 && e <= n.end + 2);
		const overlaps_a_call = (s: number, e: number) => net.some((n) => s < n.end && e > n.start);
		// an op started by a `+server` route handler while one of our calls was in flight is the
		// server side of a self-fetch (the playground's in-process APIs): the net call already says it
		const is_handler_side = (o: IoOp) =>
			!!o.caller && SERVER_ROUTE_FILE_RE.test(o.caller) && overlaps_a_call(o.start, o.start + o.ms);
		return {
			perf_start: cap.perf_start,
			window: w,
			calls: [
				// spans first: the timeline draws them as the overlay a call or a gap sits inside
				...cap.spans
					.filter((s) => !s.open && s.ms >= 0)
					.map((s) => ({
						start: s.start,
						ms: s.ms,
						label: s.name,
						kind: 'span',
						caller: s.caller,
						phase: phase_of(s.caller)
					})),
				...cap.net.map((c) => ({
					start: c.start,
					ms: c.ms < 0 ? -1 : c.ms + (c.body_ms ?? 0),
					label: label_call(c.method, c.url),
					kind: 'net',
					caller: c.caller,
					phase: phase_of(c.caller)
				})),
				...cap.io_ops
					.filter(
						(o) =>
							!o.open &&
							o.ms >= 0.5 &&
							o.type !== 'Immediate' &&
							!!o.caller &&
							!o.caller.startsWith('/wasm/') &&
							!o.caller.includes('(/wasm/') &&
							!inside_a_call(o.start, o.start + o.ms) &&
							!is_handler_side(o)
					)
					.map((o) => ({
						start: o.start,
						ms: o.ms,
						label: `${io_kind(o.type)}${o.caller ? ` · ${o.caller}` : ''}`,
						kind: io_kind(o.type),
						caller: o.caller,
						phase: phase_of(o.caller)
					}))
			]
		};
	}

	/**
	 * The report as ONE self-contained HTML file (profiler/standalone.ts): the page is rendered
	 * through this very server (a self-request, marked internal so it is not logged as traffic),
	 * then every stylesheet, the runtime and every island chunk it reaches are fetched the same way
	 * and inlined. Needs a BUILT app: a dev server's module graph is Vite's, hundreds of unbundled
	 * files with transforms — not a thing one file can carry.
	 */
	async #report_html(stored: StoredReport, ctx: RouteCtx): Promise<Response> {
		if (this.dev) {
			return new Response(
				'The standalone HTML export needs a built app (vite build + preview, or your production ' +
					'deploy): on the dev server the page’s code is hundreds of unbundled modules. Export the ' +
					'.ogp here and open it on a built server, or run the export there.',
				{ status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } }
			);
		}
		const origin = ctx.url.origin;
		const page_url = `${origin}${this.base}/report/${stored.meta.id}`;
		const headers: Record<string, string> = { 'x-og-profiler-internal': '1' };
		if (this.secret) headers['x-profiler-key'] = this.secret;
		const load = async (url: string): Promise<string | null> => {
			try {
				const res = await fetch(url, { headers });
				return res.ok ? await res.text() : null;
			} catch {
				return null;
			}
		};
		const html = await load(page_url);
		if (html === null) return new Response('Could not render the report page.', { status: 502 });
		const { build_standalone } = await import('./standalone.js');
		try {
			const out = await build_standalone(html, { page_url, load });
			return new Response(out, {
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'content-disposition': `attachment; filename="ogygia-profile-${stored.meta.id}.html"`,
					'cache-control': 'no-store'
				}
			});
		} catch (e) {
			return new Response(e instanceof Error ? e.message : 'standalone export failed', { status: 500 });
		}
	}

	/** Two stored reports side by side (compare.ts); a 404 when either has expired. */
	#compare(a: string | undefined, b: string | undefined) {
		const A = this.#reports.get(a ?? '');
		const B = this.#reports.get(b ?? '');
		if (!A || !B) error(404, 'One of those reports has expired.');
		const pack = (s: StoredReport) => ({
			meta: s.meta,
			analysis: s.analysis,
			findings: derive_findings(s.analysis, s.meta, this.#report_extras(s)).map(
				(f) => `${f.code}: ${f.message}`
			)
		});
		return { base: this.base, cmp: compare_reports(pack(A), pack(B)) };
	}

	/** DEV ONLY: nine lines of a local source file around `l` — the source peek an expanded row
	 *  shows. Behind the login like every route; the path must resolve inside the project (the
	 *  process cwd, symlinks followed) and be a source file. Anything else is a 404. */
	async #source(ctx: RouteCtx): Promise<Response> {
		if (!this.dev) return new Response('Not found', { status: 404 });
		const p = ctx.url.searchParams.get('p') ?? '';
		const line = Math.max(1, Number(ctx.url.searchParams.get('l')) || 1);
		try {
			const fs = await import('node:fs');
			const path = await import('node:path');
			const real = fs.realpathSync(p);
			const root = fs.realpathSync(process.cwd());
			if (!real.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
			if (!SOURCE_EXT_RE.test(real)) return new Response('Not found', { status: 404 });
			const lines = fs.readFileSync(real, 'utf8').split('\n');
			const start = Math.max(1, line - 4);
			const end = Math.min(lines.length, line + 4);
			return ctx.json({ path: real, start, line, lines: lines.slice(start - 1, end) });
		} catch {
			return new Response('Not found', { status: 404 });
		}
	}

	/** No open redirect — a `next` only bounces back into the profiler. */
	#safe_next(next: string | null): string {
		const n = next ?? this.base;
		return n.startsWith(this.base) ? n : this.base;
	}

	/** Clear the session cookie and bounce to the dashboard. */
	#logout(ctx: RouteCtx): Response {
		const res = ctx.redirect(this.base);
		res.headers.append('set-cookie', this.#session_cookie('', ctx.event!));
		res.headers.append('set-cookie', this.#beacon_cookie(false, ctx.event!));
		return res;
	}

	#dashboard(by: string | null) {
		const tag_keys = new Set<string>();
		for (const e of this.#ring) for (const k of Object.keys(e.tags ?? {})) tag_keys.add(k);
		return {
			base: this.base,
			recent: this.#ring,
			routes: route_aggregates(this.#ring, by && tag_keys.has(by) ? by : null),
			by: by && tag_keys.has(by) ? by : null,
			tag_keys: [...tag_keys].sort(),
			reports: [...this.#reports.values()].map((r) => r.meta).reverse(),
			recording: this.#recorder_busy || this.#recording_active(),
			dev: this.dev,
			rss_mb: Math.round(process.memoryUsage().rss / 1048576),
			inflight: this.#inflight,
			history: page_history([...this.#reports.values()].map((r) => r.meta))
		};
	}

	// The interactive run page: shows a progress bar, fires the profile at /page from an island, then
	// swaps to the report. Both the dashboard "Profile a page" form and the devtools Profiler tab point
	// here (the tab embeds it in an iframe), so the progress UX lives in one place.
	#run_page(ctx: RouteCtx) {
		const q = ctx.url.searchParams;
		const path = q.get('p') ?? '';
		if (!path.startsWith('/') || path.startsWith('//')) {
			return error(400, 'Give a path on this site, like /docs/overview.');
		}
		const runs = clamp(Number(q.get('runs')) || 5, 1, 50);
		const format = q.get('format') === 'ogp' ? 'ogp' : '';
		return { base: this.base, path, runs, format };
	}

	// Manually clear a wedged recording flag (belt-and-suspenders with the time-based auto-heal).
	// The dashboard's Reset: the escape hatch for a wedged recording. Clears the site-wide attribution tax
	// AND frees the recorder lock so a new profile can start on this worker.
	#reset(ctx: RouteCtx): Response {
		this.#recording_since = 0;
		this.#release_als();
		this.#recorder_busy = false;
		return ctx.redirect(this.base);
	}

	// The page-profile recording: warm-up + redirect-resolve, a serverless-budgeted run loop, and the
	// always-on coverage pass. Redirects to the report (or ?format=json / ?format=ogp).
	async #record_page(ctx: RouteCtx): Promise<Response> {
		const event = ctx.event!; // event.fetch (Kit's internal SSR render) is the one thing only Kit gives
		// One recording per worker (shared inspector). If this worker is busy, refuse immediately with a
		// 409 the client retries — don't hold a waiter in memory (unreliable on a worker that may be
		// recycled within 30 s). The retry lands on a free worker (serverless) or comes back once this one
		// finishes (single server). Reset on the dashboard clears a wedged one.
		if (!this.#try_acquire_recorder()) {
			return new Response(
				JSON.stringify({
					busy: true,
					message:
						'A profile is already running on this worker. Waiting for it to finish (or for a free worker).'
				}),
				{
					status: 409,
					headers: {
						'content-type': 'application/json; charset=utf-8',
						'retry-after': '2',
						'cache-control': 'no-store'
					}
				}
			);
		}
		const q = ctx.url.searchParams;
		this.#recording_since = Date.now();
		// Backstop for a wedged run: if the profiled page (or one of its upstream calls) hangs and this
		// method never reaches its `finally`, force-clear the recording state at the hard cap so the whole
		// site stops paying the attribution tax now — don't wait out RECORDING_MAX_MS. An orphaned run that
		// later settles finds recording already cleared and simply drops its result.
		const watchdog = setTimeout(() => {
			this.#recording_since = 0;
			this.#release_als();
		}, RECORDING_HARD_CAP_MS + 2_000);
		watchdog.unref?.();
		// Re-assert the fetch patch right before profiling — `globalThis.fetch` may have been replaced
		// since install, which is why runs sometimes missed network. Self-heals to reliable capture.
		this.#ensure_net?.();
		try {
			const path = q.get('p') ?? '';
			if (!path.startsWith('/') || path.startsWith('//')) {
				return error(400, 'Give a path on this site, like /docs/overview.');
			}
			const runs = clamp(Number(q.get('runs')) || 5, 1, 50);
			const interval = clamp(Number(q.get('interval')) || 200, 50, 10_000);
			// The whole /page request has to return before the platform's gateway kills it (Amplify 30s,
			// Netlify 10s, Vercel 300s, …). Start the budget clock now — warm-up, CPU runs, AND the
			// coverage pass all live inside it. Infinity on a real server.
			const work_budget = serverless_work_budget_ms();
			// Cap the run at the hard limit even on a real server (Infinity budget): a page recording must
			// never outlive RECORDING_HARD_CAP_MS, because it holds the site-wide attribution context open.
			const budget_deadline = Number.isFinite(work_budget) ? Date.now() + work_budget : Infinity;
			const deadline = Math.min(budget_deadline, Date.now() + RECORDING_HARD_CAP_MS);
			// Each render is raced against a timeout so a single hung upstream can't pin the recording (and
			// the site) — the smaller of PER_RENDER_TIMEOUT_MS and whatever budget is left.
			const fetch_render = (p: string) => {
				const left = deadline - Date.now();
				const ms = Number.isFinite(left)
					? Math.max(1, Math.min(PER_RENDER_TIMEOUT_MS, left))
					: PER_RENDER_TIMEOUT_MS;
				return with_timeout(
					event.fetch(p, { headers: { 'x-og-profiler-internal': '1' } }),
					ms,
					'render timed out (the page or one of its upstream calls did not return in time)'
				);
			};

			// Warm-up + redirect resolve. `/fr/fr` may 308 → `/fr/fr/` (trailing slash), or i18n-redirect;
			// profiling the 3xx measures nothing (the classic "3 ms window, no components" report). Follow
			// the chain HERE, once, un-profiled (it also pays the cold module-load cost), and profile the
			// FINAL url. The warm-up's own wall time is reported so a caching app is obvious.
			let target = path;
			let redirected_from: string | undefined;
			let warmup_ms: number | undefined;
			let warm_status = 0;
			let warm_bytes = 0;
			for (let hop = 0; hop < 5; hop++) {
				const t = performance.now();
				let res: Response;
				try {
					res = await fetch_render(target);
				} catch {
					break; // warm-up failure surfaces on the real runs below
				}
				const body = await res.text();
				warmup_ms = round2(performance.now() - t);
				warm_status = res.status;
				warm_bytes = body.length;
				// fetch may follow same-origin redirects itself (res.redirected) or hand back the 3xx
				const next = res.redirected
					? new URL(res.url).pathname + new URL(res.url).search
					: res.status >= 300 && res.status < 400
						? (() => {
								const loc = res.headers.get('location');
								if (!loc) return null;
								const u = new URL(loc, event.url.origin);
								return u.pathname + u.search;
							})()
						: null;
				if (!next || next === target) break;
				redirected_from ??= path;
				target = next;
			}

			const run_ms: number[] = [];
			const run_windows: Array<{ start: number; end: number }> = [];
			let run_status = warm_status;
			let run_bytes = warm_bytes;
			let budget_note: string | undefined;
			// Reserve room for the coverage pass (call counts — "traverse ×768k") so a slow page can never
			// consume the whole budget on CPU runs and starve it. One render ≈ the warm-up's wall time.
			const coverage_reserve = Math.max(warmup_ms ?? 0, 300);
			const cap = await this.#capture_window(interval, async () => {
				for (let i = 0; i < runs; i++) {
					// Stop early if another CPU run + the reserved coverage pass wouldn't finish in time.
					if (i > 0 && Date.now() + (warmup_ms ?? 0) + coverage_reserve > deadline) {
						const budget_label =
							work_budget >= 1000
								? `${Math.round(work_budget / 1000)}s`
								: `${Math.round(work_budget)}ms`;
						budget_note =
							`Ran ${i} of ${runs} render${i === 1 ? '' : 's'} — trimmed to fit the ` +
							`${budget_label} serverless budget (the page renders in ~${Math.round(warmup_ms ?? 0)}ms). ` +
							`Fewer runs, same accuracy per run.`;
						break;
					}
					const t = performance.now();
					let res: Response;
					try {
						res = await fetch_render(target);
					} catch {
						// A render timed out (hung page/upstream). Stop the loop and finish with the runs we
						// already have rather than failing the whole recording — and let the outer finally
						// clear the recording state so the site is not held hostage to this page.
						budget_note =
							i > 0
								? `Ran ${i} of ${runs} renders — stopped early, a later render hung ` +
									`(the page or an upstream call did not return within ${Math.round(PER_RENDER_TIMEOUT_MS / 1000)}s).`
								: undefined;
						break;
					}
					const body = await res.text();
					const done = performance.now();
					run_status = res.status;
					run_bytes = body.length;
					run_ms.push(round2(done - t));
					run_windows.push({ start: t, end: done });
					// let the event loop turn once between renders: flushes the GC
					// PerformanceObserver (its entries arrive on a macrotask) and keeps
					// each render a clean, separately-attributed unit
					await new Promise((r) => setImmediate(r));
				}
			});
			// Every render hung/failed → nothing to report. Don't build an empty report; tell the user.
			if (run_ms.length === 0) {
				return error(
					504,
					'The page did not return in time to profile it. It (or an upstream call it makes) is ' +
						'either hung or slower than the recording budget — try a lighter path, or check that ' +
						'page for a stuck request.'
				);
			}
			// N identical renders → N copies of the same outbound calls. Keep one render's worth so
			// the waterfall shows one request + its leaf calls, not the same handful ×N.
			cap.window = scope_net_to_one_run(cap, run_windows) ?? undefined;
			// call counts come from ONE extra render under precise coverage — a
			// SEPARATE pass, because coverage stops V8 inlining and would otherwise
			// inflate the CPU profile (svelte's hot `child`/`push` would dominate).
			// Always run it (the ×N counts are the point) — the loop above reserved its time.
			cap.call_counts = await this.#count_calls(async () => {
				await fetch_render(target).then((r) => r.text());
			});
			const id = await this.#finish_report(
				cap,
				{
					trigger: 'page',
					page: target,
					redirected_from,
					warmup_ms,
					run_status,
					run_bytes,
					budget_note,
					runs: run_ms
				},
				// the app's own fetch answers a hashed asset on adapter-node (it reads the file); a
				// preview / static host serves it over the wire instead, so fall back to the origin
				async (u) => {
					try {
						const r = await event.fetch(u, { headers: { 'x-og-profiler-internal': '1' } });
						if (r.ok) return r;
					} catch {
						// not answered internally
					}
					return fetch(new URL(u, event.url.origin), { headers: { 'x-og-profiler-internal': '1' } });
				}
			);
			const s = this.#reports.get(id)!;
			// serverless (Amplify/Vercel/Netlify) can't keep the report in memory across invocations
			// AND a fresh instance may serve the follow-up render — so `?format=ogp` streams the whole
			// profile back NOW as an encrypted `.ogp` the user re-opens at `<base>/view`. This is also
			// the reliable path when the full report is too heavy for the browser. `?format=json` is
			// the curated agent view.
			if (q.get('format') === 'ogp') {
				return this.#ogp_response(id, s);
			}
			const wants_json =
				q.get('format') === 'json' ||
				(ctx.request.headers.get('accept') ?? '').includes('application/json');
			if (wants_json) {
				return ctx.json(report_json(s.analysis, s.meta, this.base, this.#report_extras(s)));
			}
			// the session cookie is seated by the gate in #ui, not here
			return ctx.redirect(ctx.href('/report/[id]', { id }));
		} catch (e) {
			// A deliberate `error()`/`redirect()` from inside the try (bad path 400, empty-runs 504, …) is a
			// control-flow throw the router renders — let it through. Only a REAL exception becomes a 500.
			if (is_http_error(e) || is_redirect(e)) throw e;
			return error(
				500,
				e instanceof Error && INSPECTOR_ERR.test(e.message)
					? 'CPU profiling needs a Node.js server (adapter-node or dev). This platform does not expose the V8 inspector.'
					: `Profiling failed: ${e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			clearTimeout(watchdog);
			this.#recording_since = 0;
			this.#release_als();
			this.#release_recorder();
		}
	}

	// Open a saved profile (the /view POST). The upload island POSTs the .ogp bytes + key and expects
	// JSON: `{ url }` to navigate to, or `{ error }`. We STORE the dump and hand back its /report/<id>
	// URL rather than render inline — the report is an islands page, so it must load normally to hydrate.
	async #upload(ctx: RouteCtx): Promise<Response> {
		try {
			// Tolerate a `.ogp` mangled by a text-y transfer between machines (a prepended BOM, or the whole
			// file base64-encoded) — recover the raw bytes before checking the magic.
			const bytes = recover_ogp_bytes(new Uint8Array(await ctx.request.arrayBuffer()));
			if (!is_ogp(bytes)) {
				return ctx.json(
					{
						error:
							'That file is not an ogygia .ogp profile. If you moved it between machines, copy it as a ' +
							'binary file — a text editor or chat can silently re-encode it.'
					},
					{ status: 400 }
				);
			}
			// Brotli + AES-GCM. Decrypt with the key the uploader supplies (`x-ogp-key`) so ANY .ogp opens
			// in ANY profiler — its key can differ from this instance's secret. Left blank, we fall back to
			// THIS profiler's own secret, so the reports it made re-open without retyping the key (the
			// upload form says so). A wrong key fails the GCM tag → caught below.
			const ogp_key = ctx.request.headers.get('x-ogp-key') || this.secret;
			const dump: unknown = await ogp_decode(bytes, ogp_key);
			if (!is_dump(dump)) {
				return ctx.json({ error: 'That file is not an ogygia profiler dump.' }, { status: 400 });
			}
			return ctx.json({ url: ctx.href('/report/[id]', { id: this.#store_uploaded(dump) }) });
		} catch {
			return ctx.json(
				{ error: "That file isn't a profile, or it was made with a different key." },
				{ status: 400 }
			);
		}
	}

	// The report page, its JSON, and its raw .cpuprofile all take the ALREADY-looked-up report — the
	// shared `/report/[id]` layer load in profiler-router does the lookup + 404 once and cascades it.
	#report_json(stored: StoredReport): Response {
		const body = report_json(stored.analysis, stored.meta, this.base, this.#report_extras(stored));
		return new Response(JSON.stringify(body), {
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}

	/** The RAW dump JSON (`{ kind, version, meta, analysis, extras }`) the share-link viewer renders —
	 *  the same shape `.ogp` carries. Authed (only the owner mints a link); the recipient never hits it. */
	#report_dump_json(stored: StoredReport): Response {
		const body = report_dump(stored.analysis, stored.meta, this.#report_extras(stored));
		return new Response(JSON.stringify(body), {
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		});
	}

	async #report_raw(stored: StoredReport): Promise<Response> {
		let body: string;
		if (typeof stored.raw === 'string') {
			body = stored.raw;
		} else {
			try {
				const { gunzipSync } = await import('node:zlib');
				body = gunzipSync(stored.raw).toString('utf8');
			} catch {
				// no zlib to inflate — serve the gzip bytes with the encoding header
				return new Response(new Uint8Array(stored.raw), {
					headers: {
						'content-type': 'application/json',
						'content-encoding': 'gzip',
						'content-disposition': `attachment; filename="ssr-${stored.meta.id}.cpuprofile"`,
						'cache-control': 'no-store'
					}
				});
			}
		}
		return new Response(body, {
			headers: {
				'content-type': 'application/json',
				'content-disposition': `attachment; filename="ssr-${stored.meta.id}.cpuprofile"`,
				'cache-control': 'no-store'
			}
		});
	}

	/**
	 * Render a report page with its dump embedded as an encrypted `.ogp` (base64), so the Export button
	 * downloads it with no server round-trip (the report may be evicted by then) and no key in the page.
	 * Encoding is async (Brotli + scrypt off-thread — never blocks the event loop) and best-effort: if
	 * Node crypto/zlib is unavailable (a stripped edge runtime), the Export button is simply omitted and
	 * the JSON / .cpuprofile links still work.
	 */
	async #report_view(stored: StoredReport) {
		const { analysis: a, meta } = stored;
		const extras = this.#report_extras(stored);
		let ogpB64: string | undefined;
		try {
			const bytes = await ogp_encode(report_dump(a, meta, extras), this.secret);
			ogpB64 = Buffer.from(bytes).toString('base64');
		} catch {
			ogpB64 = undefined;
		}
		// this page's other page-mode reports (oldest first) and the one just before this one — the
		// history line + the "compare with previous" link
		const history =
			meta.trigger === 'page' && meta.page
				? (page_history([...this.#reports.values()].map((r) => r.meta)).find(
						(h) => h.page === meta.page
					) ?? null)
				: null;
		const i = history ? history.points.findIndex((p) => p.id === meta.id) : -1;
		const prev = i > 0 ? history!.points[i - 1].id : null;
		return { a, meta, base: this.base, extras, ogpB64, history, prev, dev: this.dev };
	}

	/** Store an uploaded dump as a report so it renders (+ hydrates) at its own /report/<id> URL — an
	 *  islands page can't be swapped in via document.write. No cpuprofile in a dump, so `raw` is empty
	 *  (its /raw link just 404s; everything else works). */
	#store_uploaded(dump: { analysis: Analysis; meta: ReportMeta; extras: ReportExtras }): string {
		const id = Math.random().toString(36).slice(2, 10);
		const e = dump.extras;
		this.#reports.set(id, {
			meta: { ...dump.meta, id },
			analysis: dump.analysis,
			heap: e.heap,
			net: e.net,
			mem: e.mem,
			measures: e.measures ?? [],
			gc: e.gc ?? null,
			io: e.io ?? [],
			call_counts: e.call_counts ?? {},
			raw: '',
			...(e.weights ? { weights: e.weights } : {}),
			...(e.client ? { client: e.client } : {})
		});
		while (this.#reports.size > this.max_reports) {
			const oldest = this.#reports.keys().next().value;
			if (oldest === undefined) break;
			this.#reports.delete(oldest);
		}
		return id;
	}

	/** The full profile as an encrypted `.ogp` download (Brotli + AES-GCM, async — never blocks). */
	async #ogp_response(id: string, stored: StoredReport): Promise<Response> {
		const bytes = await ogp_encode(
			report_dump(stored.analysis, stored.meta, this.#report_extras(stored)),
			this.secret
		);
		return new Response(new Uint8Array(bytes), {
			headers: {
				'content-type': 'application/octet-stream',
				'content-disposition': `attachment; filename="profile-${id}.ogp"`,
				'cache-control': 'no-store'
			}
		});
	}

	#report_extras(stored: StoredReport): ReportExtras {
		const client = stored.client ?? this.#client_for(stored);
		return {
			net: stored.net,
			spans: stored.spans ?? [],
			heap: stored.heap,
			mem: stored.mem,
			measures: stored.measures,
			gc: stored.gc,
			io: stored.io,
			call_counts: stored.call_counts,
			...(stored.weights ? { weights: stored.weights } : {}),
			...(client.length ? { client } : {})
		};
	}

	/** The browser's hydration timings for THIS report's islands: the beacon ring joined by
	 *  fingerprint (the same props → the same fingerprint, so a visit after the recording matches),
	 *  then merged per island — a list of 48 cards is 48 fingerprints and one row. */
	#client_for(stored: StoredReport): ClientIslandStat[] {
		const per_entry = new Map<string, { fp: string; name: string; ms: number[]; load: number[] }>();
		for (const r of island_rows_of(stored.meta)) {
			const b = this.#beacons.get(r.fp);
			if (!b || !b.ms.length) continue;
			let e = per_entry.get(r.entry);
			if (!e) per_entry.set(r.entry, (e = { fp: r.fp, name: r.name, ms: [], load: [] }));
			e.ms.push(...b.ms);
			e.load.push(...b.load);
		}
		const out: ClientIslandStat[] = [];
		for (const [entry, e] of per_entry) {
			const ms = e.ms.sort((x, y) => x - y);
			const load = e.load.sort((x, y) => x - y);
			out.push({
				fp: e.fp,
				entry,
				name: e.name,
				n: ms.length,
				p50_ms: round2(percentile(ms, 0.5)),
				max_ms: round2(ms[ms.length - 1]),
				load_p50_ms: round2(percentile(load, 0.5))
			});
		}
		return out;
	}

	/** `/beacon` (POST, authed): the runtime's hydration timings — `{ islands: [{ fp, entry, ms, load }] }`.
	 *  Bounded every way (body, islands per post, fingerprints kept, samples per fingerprint). */
	async #beacon(ctx: RouteCtx): Promise<Response> {
		let body: unknown;
		try {
			const text = await ctx.request.text();
			if (text.length > MAX_BEACON_BODY) return new Response(null, { status: 413 });
			body = JSON.parse(text);
		} catch {
			return new Response(null, { status: 400 });
		}
		const islands = (body as { islands?: unknown })?.islands;
		if (!Array.isArray(islands)) return new Response(null, { status: 400 });
		const now = Date.now();
		for (const it of islands.slice(0, MAX_BEACON_ISLANDS)) {
			const fp = typeof it?.fp === 'string' ? it.fp : '';
			const ms = Number(it?.ms);
			const load = Number(it?.load);
			if (!/^[0-9a-f]{8,32}$/.test(fp) || !Number.isFinite(ms) || ms < 0 || ms > 600_000) continue;
			let agg = this.#beacons.get(fp);
			if (!agg) {
				if (this.#beacons.size >= MAX_BEACON_FPS) {
					// drop the stalest fingerprint
					let oldest: string | undefined;
					let t = Infinity;
					for (const [k, v] of this.#beacons) if (v.last < t) (t = v.last), (oldest = k);
					if (oldest !== undefined) this.#beacons.delete(oldest);
				}
				this.#beacons.set(fp, (agg = { entry: typeof it?.entry === 'string' ? it.entry.slice(0, 300) : '', ms: [], load: [], last: now }));
			}
			agg.last = now;
			agg.ms.push(round2(ms));
			agg.load.push(Number.isFinite(load) && load >= 0 ? round2(Math.min(load, ms)) : 0);
			if (agg.ms.length > MAX_BEACON_SAMPLES) {
				agg.ms.shift();
				agg.load.shift();
			}
		}
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
	}

	/** The page the profiler's own user is about to view gets the beacon tag: the runtime posts its
	 *  hydration timings to `/beacon` when it sees it, and does nothing otherwise. The flag cookie
	 *  (set at login, site-wide, no secret) or the key header says it is that user; dev is open. The
	 *  tag goes at the end of `<head>` so the runtime bootstrap stays the first script. A visitor
	 *  never sees it; a stray flag with no session posts to a guarded route and gets nothing. */
	async #beacon_tag(event: RequestEvent): Promise<string | null> {
		if (!this.ui_enabled) return null;
		const dest = event.request.headers.get('sec-fetch-dest');
		if (dest ? dest !== 'document' : !(event.request.headers.get('accept') ?? '').includes('text/html')) return null;
		if (!this.dev) {
			const key = event.request.headers.get('x-profiler-key');
			if (key ? !(await this.#key_matches(key)) : event.cookies.get('og_profiler_beacon') !== '1') return null;
		}
		return `<meta name="${BEACON_META}" content="${this.base}/beacon">`;
	}

	// ---- the handle -------------------------------------------------------
	handle: Handle = async ({ event, resolve }) => {
		if (this.#disabled) return resolve(event);
		await this.#init();

		const on_ui_path =
			event.url.pathname === this.base || event.url.pathname.startsWith(this.base + '/');
		if (this.ui_enabled && on_ui_path) {
			return this.#ui(event);
		}
		// Enabled by config but NO secret set in production → the UI is off. Someone still hit the UI
		// path; OWN the response with a clear 404 instead of falling through — otherwise the app's own
		// routing (e.g. an i18n catch-all) can silently redirect `/__profiler` to the home page, which
		// looks like the profiler is broken. This tells the developer exactly what to set.
		if (!this.#disabled && !this.ui_enabled && !this.dev && this.secret === '' && on_ui_path) {
			return new Response(
				'ogygia profiler is installed but disabled: set OGYGIA_PROFILER_SECRET (or ' +
					'`ogygia({ profiler: { secret } })`) to enable the UI in production.',
				{
					status: 404,
					headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
				}
			);
		}

		const entry: RequestEntry = {
			ts: Date.now(),
			method: event.request.method,
			path: event.url.pathname,
			route: event.route?.id ?? null,
			status: 0,
			ms: 0,
			cpu_ms: 0,
			inflight: this.#inflight,
			net_ms: 0,
			net_count: 0,
			internal: event.request.headers.get('x-og-profiler-internal') === '1' || undefined
		};

		// Header-triggered single-request profile? Decided FIRST, because it is one of the three
		// reasons a request gets a network-attribution context at all.
		const profile_header = event.request.headers.get('x-profile');
		const key_ok =
			!!profile_header && this.ui_enabled && (await this.#key_matches(profile_header));
		// Take the recorder slot atomically (no await between the check and the take): two concurrent
		// header-profiled requests must not both start a recording and collide on the one process-wide
		// inspector. If it's busy, this request just renders un-profiled rather than waiting.
		const header_profile = key_ok && this.#try_acquire_recorder();

		// PAY ONLY WHEN PROFILING. Attributing outbound calls to a request means running it inside
		// an AsyncLocalStorage, and on Node 20 every ALS in flight costs a store copy per async hop —
		// a page with 475k hops paid ~0.2 s to this one ALS while nothing was being recorded. So in
		// production the context exists only while a profile is actually being taken (a page-mode
		// recording, or this request's own header profile); an idle request is wall time + CPU usage
		// and nothing else. Dev keeps it always on: Server-Timing's outbound breakdown is a dev tool,
		// and dev latency is nobody's metric.
		const attribute =
			!!this.#als && (this.dev || this.#recording_active() || header_profile);
		const self = this;
		const ctx: Ctx | null = attribute
			? {
					entry,
					net: [],
					spans: [],
					route: entry.route,
					path: entry.path,
					on_net(call) {
						if (this.net.length < MAX_NET_PER_REQUEST) this.net.push(call);
						self.#collect_window(call);
					}
				}
			: null;

		const start = performance.now();
		const cpu0 = process.cpuUsage();
		this.#inflight++;

		const beacon_tag = await this.#beacon_tag(event);
		const resolve_page = () =>
			beacon_tag
				? resolve(event, {
						transformPageChunk: ({ html }) => (HEAD_CLOSE_RE.test(html) ? html.replace(HEAD_CLOSE_RE, beacon_tag + '</head>') : html)
					})
				: resolve(event);
		const run = async (): Promise<Response> => {
			const res =
				ctx && this.#als ? await this.#als.run(ctx, resolve_page) : await resolve_page();
			entry.status = res.status;
			if (this.want_server_timing) {
				try {
					const ms = performance.now() - start;
					res.headers.append('Server-Timing', `ssr;desc="SvelteKit render";dur=${ms.toFixed(1)}`);
					if (ctx?.net.length) {
						const net_ms = ctx.net.reduce((a, c) => a + Math.max(c.ms, 0) + (c.body_ms ?? 0), 0);
						res.headers.append(
							'Server-Timing',
							`net;desc="outbound (${ctx.net.length})";dur=${net_ms.toFixed(1)}`
						);
					}
				} catch {
					// immutable headers (e.g. a cached Response) — skip
				}
			}
			return res;
		};

		// header-triggered single-request profile (decided above)
		if (header_profile) {
			this.#recording_since = Date.now();
			// Same site-unblock backstop as the page path: if this request wedges inside the capture, don't
			// leave the whole site paying the attribution tax past the hard cap.
			const watchdog = setTimeout(() => {
				this.#recording_since = 0;
				this.#release_als();
			}, RECORDING_HARD_CAP_MS + 2_000);
			watchdog.unref?.();
			try {
				let res: Response | undefined;
				const cap = await this.#capture_window(100, async () => {
					res = await run();
				});
				this.#finalize(entry, start, cpu0, ctx, event.request);
				cap.window = { start, end: start + entry.ms };
				const id = await this.#finish_report(cap, {
					trigger: 'request',
					request: { method: entry.method, path: entry.path, route: entry.route, ms: entry.ms }
				});
				try {
					res?.headers.append('x-profile-report', `${this.base}/report/${id}`);
				} catch {
					// immutable headers
				}
				return res!;
			} finally {
				clearTimeout(watchdog);
				this.#recording_since = 0;
				this.#release_als();
				this.#release_recorder();
			}
		}

		try {
			return await run();
		} finally {
			this.#finalize(entry, start, cpu0, ctx, event.request);
		}
	};

	#finalize(
		entry: RequestEntry,
		start: number,
		cpu0: NodeJS.CpuUsage,
		ctx: Ctx | null,
		request?: Request
	): void {
		this.#inflight--;
		entry.ms = round2(performance.now() - start);
		const c = process.cpuUsage(cpu0);
		entry.cpu_ms = round2((c.user + c.system) / 1000);
		// what ogygia's handle added to this page (seed / props bytes, transform ms) — recorded by
		// hooks.ts on the request, read back here so the log and the report can show ogygia's own cost
		const og = request ? request_stats_of(request) : undefined;
		if (og) entry.og = og;
		const hole = request ? hole_stats_of(request) : undefined;
		if (hole) entry.hole = hole;
		if (ctx) {
			entry.net_count = ctx.net.length;
			entry.net_ms = round2(ctx.net.reduce((a, c) => a + Math.max(c.ms, 0) + (c.body_ms ?? 0), 0));
			if (ctx.spans.length) {
				entry.span_count = ctx.spans.length;
				// top-level spans only: a nested span's time is inside its parent's
				entry.span_ms = round2(
					ctx.spans.filter((s) => s.parent === undefined && s.ms >= 0).reduce((a, s) => a + s.ms, 0)
				);
			}
		}
		this.#ring.push(entry);
		if (this.#ring.length > this.ring_size) this.#ring.shift();
	}
}

/**
 * Build a profiler handle. INTERNAL — the profiler is configured in vite.config.ts
 * (`ogygia({ profiler: true })`) and `ogygia.handle()` constructs + mounts this itself.
 * Kept as a named export only so the handle's lazy import can reach it; it is not a
 * public entry point.
 *
 * See the class doc and README for what it captures. Visit `<path>` (default
 * /__profiler) — in prod, log in (or send the x-profiler-key header).
 */
export function profiler(options: ProfilerOptions = {}): Handle {
	const instance = new Profiler(options);
	return (args) => instance.handle(args);
}

// ---------------------------------------------------------------------------

function route_aggregates(ring: RequestEntry[], by: string | null = null): RouteAgg[] {
	const by_route = new Map<string, RequestEntry[]>();
	for (const e of ring) {
		if (e.internal) continue;
		// split by a request tag (`tag('tenant', …)`): one row per route × value
		const key = (e.route ?? '(no route)') + (by ? ` · ${by}=${e.tags?.[by] ?? '—'}` : '');
		let list = by_route.get(key);
		if (!list) by_route.set(key, (list = []));
		list.push(e);
	}
	const aggs: RouteAgg[] = [];
	for (const [route, list] of by_route) {
		const sorted = list.map((e) => e.ms).sort((a, b) => a - b);
		const net = list.map((e) => e.net_ms).sort((a, b) => a - b);
		aggs.push({
			route,
			count: list.length,
			p50: pct(sorted, 50),
			p95: pct(sorted, 95),
			max: sorted.at(-1) ?? 0,
			avg: round2(sorted.reduce((a, c) => a + c, 0) / (sorted.length || 1)),
			net_p50: pct(net, 50)
		});
	}
	return aggs.sort((a, b) => b.p95 - a.p95);
}

function pct(sorted: number[], p: number): number {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

/** Race a promise against a wall-time so a hung render can never pin a recording (and, through the
 *  attribution AsyncLocalStorage, the whole site). Rejects with `label` on timeout; the underlying work
 *  is left to settle on its own — the caller has already moved on. */
function with_timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	if (!Number.isFinite(ms) || ms <= 0) return p;
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(label)), ms);
		timer.unref?.();
	});
	return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export type { Analysis, CpuProfile, HeapAllocator } from './analyze.js';
export type { NetCall } from './net.js';
export type { ReportMeta, RequestEntry } from './report.js';
