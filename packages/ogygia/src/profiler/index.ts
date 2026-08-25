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
 * - Always on (near-zero cost): wall time + outbound network per request,
 *   per-route p50/p95, Server-Timing headers.
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
import { ogp_encode, ogp_decode, is_ogp } from './crypto.js';
import { type Router, type Ctx as RouteCtx } from '../router/index.js';
import { build_profiler_router } from './profiler-router.js';

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
	 * Patch fetch/http to attribute outbound calls, and wrap each request in an
	 * AsyncLocalStorage. Default true. Set false for the leanest always-on path:
	 * wall timing only, no per-request context and no global patches.
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
	mem: MemSample[];
	measures: UserTiming[];
	gc: GcSummary | null;
	io: IoOp[];
	call_counts: Record<string, number>;
	/** the raw .cpuprofile, gzipped — a 10s profile is multiple MB of JSON, so
	 * we keep it compressed (~10×) and inflate only on download */
	raw: Buffer | string;
}

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
}

interface WindowCapture {
	profile: CpuProfile;
	heap: HeapNode | null;
	mem: MemSample[];
	net: NetCall[];
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
}

const MAX_NET_PER_REQUEST = 100;
const MAX_WINDOW_NET = 2000;
const MAX_BACKGROUND_NET = 300;
// A recording that started longer ago than this is treated as abandoned (a frozen/timed-out
// serverless invocation whose cleanup never ran), so the profiler unwedges itself. Longer than any
// real profile: a serverless request is capped well under this anyway.
const RECORDING_MAX_MS = 120_000;
/** an inspector-unavailable recording error (edge runtimes) vs a real profiling failure */
const INSPECTOR_ERR = /inspector/;

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
): void {
	if (windows.length <= 1) return;
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
	readonly #background_net: NetCall[] = [];
	#window_net: NetCall[] | null = null;
	#inflight = 0;
	// Epoch-ms a recording began, or 0. A TIMESTAMP (not a boolean) so a stuck run self-heals: on a
	// serverless host (Amplify/Lambda) the process can freeze or time out mid-profile and the `finally`
	// that clears it never runs — leaving a boolean flag `true` forever, which is exactly the "previous
	// session is still running, can't profile again" bug. Past RECORDING_MAX_MS a stale run is ignored.
	#recording_since = 0;
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
		this.dev =
			// replaced by Vite when the app is built; falls back to NODE_ENV
			(typeof import.meta !== 'undefined' &&
				(import.meta as { env?: { DEV?: boolean } }).env?.DEV === true) ||
			process.env.NODE_ENV === 'development';
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

			return {
				profile: profile as CpuProfile,
				heap: heap_head,
				mem,
				net,
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
				duration_ms
			};
		} finally {
			clearInterval(mem_timer);
			histogram.disable();
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
			return sourcemap_resolver((p) => {
				try {
					return fs.readFileSync(p, 'utf8');
				} catch {
					return undefined;
				}
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
		>
	): Promise<string> {
		const resolver = await this.#make_resolver();
		const analysis = analyze(cap.profile, resolver, cap.call_counts);
		const heap = cap.heap ? analyze_heap(cap.heap) : null;
		// resolve each I/O caller's bundled location back to source, using the same
		// sourcemap resolver the CPU frames use — turns `_page.server.ts.js:8` into
		// `routes/mixed/+page.server.ts:10`, and drops the bundler's chained names.
		// Keep the path relative to `src/` (not just the basename) — `+page.server.ts`
		// alone is ambiguous when many routes have one.
		const rel_src = (f: string) => {
			const clean = f.replace(/\?.*$/, '');
			const m = /(?:^|[/\\])src[/\\](.*)$/.exec(clean);
			if (m) return m[1].replace(/\\/g, '/');
			return clean.split(/[/\\]/).slice(-3).join('/');
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
		this.#reports.set(id, {
			meta,
			analysis,
			heap,
			net: cap.net,
			mem: cap.mem,
			measures: cap.measures,
			gc,
			io: cap.io_ops,
			call_counts: cap.call_counts,
			raw
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
		res.headers.append('set-cookie', this.#session_cookie(this.#cookie_token(createHash), ctx.event!));
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
		return (await this.#router().fetch(event.request, event)) ?? new Response('Not found', { status: 404 });
	}

	// Auth as a router guard (a pure pre-check): /login + /logout are always reachable (they manage the
	// session); everything else needs a valid session (dev = open; no-secret prod = hidden → 404). No
	// `?key=` (a key in a URL gets logged/cached/shared) — the browser uses the login cookie, and
	// programmatic access uses the `x-profiler-key` header. The /login POST seats the cookie; this guard
	// never touches the response.
	async #auth_guard(ctx: RouteCtx): Promise<Response | undefined> {
		const rel = ctx.url.pathname.slice(this.base.length).replace(/\/$/, '') || '/';
		if (rel === '/login' || rel === '/logout') return;
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
			dashboard: () => this.#dashboard(),
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
			report_view: (stored) => this.#report_view(stored),
			report_json: (stored) => this.#report_json(stored),
			report_raw: (stored) => this.#report_raw(stored)
		}) as Router);
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
		return res;
	}

	#dashboard() {
		return {
			base: this.base,
			recent: this.#ring,
			routes: route_aggregates(this.#ring),
			reports: [...this.#reports.values()].map((r) => r.meta).reverse(),
			recording: this.#recording_active(),
			dev: this.dev,
			rss_mb: Math.round(process.memoryUsage().rss / 1048576),
			inflight: this.#inflight
		};
	}

	// The interactive run page: shows a progress bar, fires the profile at /page from an island, then
	// swaps to the report. Both the dashboard "Profile a page" form and the devtools Profiler tab point
	// here (the tab embeds it in an iframe), so the progress UX lives in one place.
	#run_page(ctx: RouteCtx) {
		const q = ctx.url.searchParams;
		const path = q.get('p') ?? '';
		if (!path.startsWith('/') || path.startsWith('//')) {
			return ctx.error(400, 'Give a path on this site, like /docs/overview.');
		}
		const runs = clamp(Number(q.get('runs')) || 5, 1, 50);
		const format = q.get('format') === 'ogp' ? 'ogp' : '';
		return { base: this.base, path, runs, format };
	}

	// Manually clear a wedged recording flag (belt-and-suspenders with the time-based auto-heal).
	#reset(ctx: RouteCtx): Response {
		this.#recording_since = 0;
		return ctx.redirect(this.base);
	}

	// The page-profile recording: warm-up + redirect-resolve, a serverless-budgeted run loop, and the
	// always-on coverage pass. Redirects to the report (or ?format=json / ?format=ogp).
	async #record_page(ctx: RouteCtx): Promise<Response> {
		const event = ctx.event!; // event.fetch (Kit's internal SSR render) is the one thing only Kit gives
		if (this.#recording_active()) {
			return ctx.error(
				409,
				'A profile is already running. It clears itself within a couple of minutes if a run was abandoned — or hit Reset on the dashboard.'
			);
		}
		const q = ctx.url.searchParams;
		this.#recording_since = Date.now();
		// Re-assert the fetch patch right before profiling — `globalThis.fetch` may have been replaced
		// since install, which is why runs sometimes missed network. Self-heals to reliable capture.
		this.#ensure_net?.();
		try {
			const path = q.get('p') ?? '';
			if (!path.startsWith('/') || path.startsWith('//')) {
				return ctx.error(400, 'Give a path on this site, like /docs/overview.');
			}
			const runs = clamp(Number(q.get('runs')) || 5, 1, 50);
			const interval = clamp(Number(q.get('interval')) || 200, 50, 10_000);
			// The whole /page request has to return before the platform's gateway kills it (Amplify 30s,
			// Netlify 10s, Vercel 300s, …). Start the budget clock now — warm-up, CPU runs, AND the
			// coverage pass all live inside it. Infinity on a real server.
			const work_budget = serverless_work_budget_ms();
			const deadline = Number.isFinite(work_budget) ? Date.now() + work_budget : Infinity;
			const fetch_render = (p: string) =>
				event.fetch(p, { headers: { 'x-og-profiler-internal': '1' } });

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
							work_budget >= 1000 ? `${Math.round(work_budget / 1000)}s` : `${Math.round(work_budget)}ms`;
						budget_note =
							`Ran ${i} of ${runs} render${i === 1 ? '' : 's'} — trimmed to fit the ` +
							`${budget_label} serverless budget (the page renders in ~${Math.round(warmup_ms ?? 0)}ms). ` +
							`Fewer runs, same accuracy per run.`;
						break;
					}
					const t = performance.now();
					const res = await fetch_render(target);
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
			// N identical renders → N copies of the same outbound calls. Keep one render's worth so
			// the waterfall shows one request + its leaf calls, not the same handful ×N.
			scope_net_to_one_run(cap, run_windows);
			// call counts come from ONE extra render under precise coverage — a
			// SEPARATE pass, because coverage stops V8 inlining and would otherwise
			// inflate the CPU profile (svelte's hot `child`/`push` would dominate).
			// Always run it (the ×N counts are the point) — the loop above reserved its time.
			cap.call_counts = await this.#count_calls(async () => {
				await fetch_render(target).then((r) => r.text());
			});
			const id = await this.#finish_report(cap, {
				trigger: 'page',
				page: target,
				redirected_from,
				warmup_ms,
				run_status,
				run_bytes,
				budget_note,
				runs: run_ms
			});
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
			return ctx.error(
				500,
				e instanceof Error && INSPECTOR_ERR.test(e.message)
					? 'CPU profiling needs a Node.js server (adapter-node or dev). This platform does not expose the V8 inspector.'
					: `Profiling failed: ${e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			this.#recording_since = 0;
		}
	}

	// Open a saved profile (the /view POST). The upload island POSTs the .ogp bytes + key and expects
	// JSON: `{ url }` to navigate to, or `{ error }`. We STORE the dump and hand back its /report/<id>
	// URL rather than render inline — the report is an islands page, so it must load normally to hydrate.
	async #upload(ctx: RouteCtx): Promise<Response> {
		try {
			const bytes = new Uint8Array(await ctx.request.arrayBuffer());
			if (!is_ogp(bytes)) {
				return ctx.json({ error: 'That file is not an ogygia .ogp profile.' }, { status: 400 });
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
		return { a, meta, base: this.base, extras, ogpB64 };
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
			raw: ''
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
		return {
			net: stored.net,
			heap: stored.heap,
			mem: stored.mem,
			measures: stored.measures,
			gc: stored.gc,
			io: stored.io,
			call_counts: stored.call_counts
		};
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
				{ status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }
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

		const self = this;
		const ctx: Ctx | null = this.#als
			? {
					entry,
					net: [],
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

		const run = async (): Promise<Response> => {
			const res =
				ctx && this.#als ? await this.#als.run(ctx, () => resolve(event)) : await resolve(event);
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

		// header-triggered single-request profile
		const profile_header = event.request.headers.get('x-profile');
		if (
			profile_header &&
			!this.#recording_active() &&
			(await this.#key_matches(profile_header)) &&
			this.ui_enabled
		) {
			this.#recording_since = Date.now();
			try {
				let res: Response | undefined;
				const cap = await this.#capture_window(100, async () => {
					res = await run();
				});
				this.#finalize(entry, start, cpu0, ctx);
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
				this.#recording_since = 0;
			}
		}

		try {
			return await run();
		} finally {
			this.#finalize(entry, start, cpu0, ctx);
		}
	};

	#finalize(entry: RequestEntry, start: number, cpu0: NodeJS.CpuUsage, ctx: Ctx | null): void {
		this.#inflight--;
		entry.ms = round2(performance.now() - start);
		const c = process.cpuUsage(cpu0);
		entry.cpu_ms = round2((c.user + c.system) / 1000);
		if (ctx) {
			entry.net_count = ctx.net.length;
			entry.net_ms = round2(ctx.net.reduce((a, c) => a + Math.max(c.ms, 0) + (c.body_ms ?? 0), 0));
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

function route_aggregates(ring: RequestEntry[]): RouteAgg[] {
	const by_route = new Map<string, RequestEntry[]>();
	for (const e of ring) {
		if (e.internal) continue;
		const key = e.route ?? '(no route)';
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

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export type { Analysis, CpuProfile, HeapAllocator } from './analyze.js';
export type { NetCall } from './net.js';
export type { ReportMeta, RequestEntry } from './report.js';
