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
	categorize,
	chunk_component_renamer,
	heap_by_component,
	sourcemap_resolver,
	type Analysis,
	type CallFrame,
	type CpuProfile,
	type ProfileNode,
	type FrameCategory,
	type HeapAllocator,
	type HeapNode,
	type SourceMapResolver
} from './analyze.js';
import type { CallerSite, NetCall, NetContext } from './net.js';
import { TRACE_HEADER, encode_trace } from './net.js';
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
import { derive_findings, island_rows_of, island_host_renamer, island_name, type ClientIslandStat, type ClientMarkStat, type PageVitals } from './report.js';
import { load_lane_of } from './timeline.js';
import { parse_visit, merge_visits, type Visit } from './visit.js';
import { byte_strip, type ByteStrip } from './byte-strip.js';
import { build_river, load_return_keys, seed_key_bytes, type River } from './river.js';
import { SinkBuffer, type SinkRow } from './sink.js';
import { attribute_gc, heap_sites, gc_kind, type AllocSite, type AllocSlice, type GcAttribution, type GcEvent } from './gc.js';
import type { Retained, RetainedSite } from './insights.js';
import { alloc_timeline, type AllocTimeline, type HeapSample } from './alloc.js';
import { contention, type Contention } from './contention.js';
import { build_lineage, data_reads, data_prop_names, type Lineage } from './lineage.js';

/** A response body read chunk by chunk, each chunk's end offset stamped with when it arrived
 *  (ms after `t0`): the byte strip's "left the server at". */
async function read_timed(res: Response, t0: number): Promise<{ text: string; chunks: { end: number; t: number }[] }> {
	const reader = res.body?.getReader();
	if (!reader) return { text: await res.text(), chunks: [] };
	const dec = new TextDecoder();
	let text = '';
	const chunks: { end: number; t: number }[] = [];
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		text += dec.decode(value, { stream: true });
		if (chunks.length < 4000) chunks.push({ end: text.length, t: round2(performance.now() - t0) });
	}
	text += dec.decode();
	return { text, chunks };
}
import { compare_reports, page_history } from './compare.js';
import { label_call, phase_of_frame } from './timeline.js';
import { io_kind } from './async-io.js';
import { hole_stats_of, request_stats_of, set_request_stats_detail } from '../server/request-stats.js';
import { chunkContents, islandPageKeys } from 'virtual:ogygia/island-deps';
import { set_span_recorder, type SpanRecord, type SpanRecorder } from './span.js';
import { register_profiler_file } from './frames.js';

// The span recorder's `begin` lives in this file: skip its frame when finding a span's caller.
register_profiler_file();
import { error, type Router, type Ctx as RouteCtx } from '../router/index.js';
import { app_asset_rel, client_dir_candidates, client_file_finder } from './client-files.js';
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
	/**
	 * DEMAND-ONLY. The profiler module (node:inspector, crypto, its UI-rendering path) is not imported,
	 * parsed or initialised until a request actually hits the profiler path — so until you open the
	 * dashboard the app pays EXACTLY what an app with no profiler pays: no cold-start import, no
	 * always-on request log, no per-request wrap. The trade is no history: the profiler starts
	 * collecting from the first visit onward, not before. Recommended on serverless (Amplify / Lambda),
	 * where every cold start would otherwise pay the profiler's import on its TTFB. Default false (the
	 * profiler mounts on the first request and its always-on log collects from boot). Off by default so
	 * nothing changes for existing setups.
	 */
	onDemand?: boolean;
	/**
	 * CATCH THE SLOW ONE. Keep a coarse sampler running in rolling windows and keep a report only
	 * when a request in the window took longer than `over` ms — the p99 request you cannot
	 * reproduce. Built to stay cheap: a 10 ms sampling interval, no per-request context, no stack
	 * capture, no heap sampling; the request is matched to the window by time. Off by default; off
	 * on serverless hosts (an instance dies before it catches anything). Stops after `keep` reports.
	 */
	trap?: {
		over: number;
		interval?: number;
		window?: number;
		keep?: number;
		/** request headers to KEEP with a caught request so "profile it again" can replay it with the
		 *  same inputs (`['accept-language', 'x-tenant']`). Never cookies unless named here. */
		replay?: string[];
	};
	/**
	 * A CPU PROFILE IN THE BROWSER for the profiler's own user: their documents get the
	 * `Document-Policy: js-profiling` header, the runtime samples the main thread while the page
	 * hydrates (Chromium's JS Self-Profiling API) and posts the trace through the beacon; the report
	 * shows it as components, functions and a flame graph for hydration. Default true; a visitor is
	 * never sampled (no tag, no policy, no profiler).
	 */
	clientCpu?: boolean;
	/**
	 * THE SINK — for a host whose instances live seconds (Amplify, Lambda). Each instance posts what
	 * it saw as NDJSON to this URL before it dies: one small row per request, one summary per
	 * always-on sampler window, a caught request's dump. `key` goes as a bearer token (default: the
	 * profiler secret). A long-lived host posts every `every` ms (default 10 s); a serverless one
	 * posts after each request. The site view (`<base>/site`) reads the rows back from any URL you
	 * serve them from: the request cloud and the layer cake of the whole site, over days.
	 */
	sink?: { url: string; key?: string; every?: number };
	/**
	 * ALWAYS-ON SAMPLING. Every `every` seconds take one `window` ms coarse sample (10 ms interval)
	 * and fold it into a rolling "hot functions over the last hour" table on the dashboard. The
	 * accuracy comes from volume, not from one capture. Default off; off on serverless.
	 */
	sample?: { every?: number; window?: number; interval?: number };
	/**
	 * WHERE REPORTS LIVE. Default: this instance's memory (lost on restart; each browser keeps its
	 * own copies). Point this at a `ProfilerStore` — `sqliteStore(...)`, `redisStore(...)`,
	 * `postgresStore(...)` from `ogygia/profiler/storage`, or your own — and every finished report is
	 * written there and read back from there, so it survives the instance that made it and a whole
	 * team shares one list. The store is dual-written: memory stays the hot cache, the store the
	 * source of truth.
	 */
	store?: import('./storage/index.js').ProfilerStore;
}

/** One always-on sampling window's fold: the hot functions and how much time it covered. */
interface SampledWindow {
	at: number;
	ms: number;
	busy_ms: number;
	functions: { key: string; name: string; url: string; line: number; category: FrameCategory; pkg?: string; self_ms: number }[];
}
/** The dashboard's always-on view. */
export interface SampledSummary {
	every_s: number;
	window_ms: number;
	windows: number;
	since: number | null;
	sampled_ms: number;
	busy_ms: number;
	functions: { key: string; name: string; url: string; line: number; category: FrameCategory; pkg?: string; self_ms: number; windows: number }[];
}

/** The dashboard's trap view. */
export interface TrapStatus {
	over: number;
	window_ms: number;
	caught: number;
	keep: number;
	armed: boolean;
}

/** One visit's web vitals from the runtime's beacon (ms; CLS unitless). */
interface VitalsSample {
	ttfb?: number;
	fcp?: number;
	lcp?: number;
	cls?: number;
	inp?: number;
}
const MAX_VITALS_PATHS = 200;
const MAX_VITALS_SAMPLES = 30;
const MAX_SAMPLED_WINDOWS = 60;
const SAMPLED_FUNCTIONS_PER_WINDOW = 150;
const BACKGROUND_INTERVAL_US = 10_000;

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
	/** bytes per component from the same heap sample */
	heap_components?: { name: string; bytes: number }[] | null;
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
	/** what is inside each of those chunks (the build's handoff), for the same hrefs */
	contents?: Record<string, string[]>;
	/** browser hydration timings carried by an uploaded dump (a live report joins the ring instead) */
	client?: ClientIslandStat[];
	/** the page's web vitals carried by an uploaded dump */
	vitals?: PageVitals;
	/** the app's browser marks carried by an uploaded dump */
	client_marks?: ClientMarkStat[];
	/** a caught request's inputs, so it can be profiled again in full */
	replay?: { path: string; headers: Record<string, string> };
	/** the browser's CPU profile of hydration carried by an uploaded dump */
	client_cpu?: { analysis: Analysis; at: number; sample_ms: number };
	/** the browser's picture of a visit to this page (the beacon), the latest at report time */
	visit?: Visit;
	/** the rendered document as a byte strip (page mode: the last run's body) */
	strip?: ByteStrip;
	/** the data river (page mode): calls → loads → keys → islands */
	river?: River;
	/** who caused the GC: each pause joined to the allocations before it (gc.ts) */
	gc_attr?: GcAttribution;
	/** promises created in the window (count, sampled creators) */
	promises?: { count: number; top: { caller: string; share: number }[] };
	/** what one more render left alive after a full collection, by allocation site */
	retained?: Retained;
	/** when the heap grew and what ran then (alloc.ts) */
	alloc?: AllocTimeline;
	/** the other requests the instance answered while the render ran (contention.ts) */
	contention?: Contention;
	/** which component reads which page.data key, from the sources (lineage.ts) */
	lineage?: Lineage;
}

/** One island fingerprint's browser-side samples (the runtime's hydration beacon). */
interface BeaconAgg {
	entry: string;
	/** wake → data-hydrated, ms */
	ms: number[];
	/** the module-load part, ms */
	load: number[];
	/** hydrations that discarded the server DOM and re-rendered (a mismatch) */
	recovered: number;
	/** the named first divergence from the most recent recovery — the "why" (see hydrate-core) */
	reason?: string;
	last: number;
}
const MAX_BEACON_FPS = 2000;
const MAX_BEACON_SAMPLES = 64;
const MAX_BEACON_BODY = 64 * 1024;
const MAX_BEACON_CPU_BODY = 6 * 1024 * 1024;
const MAX_BEACON_VISIT_BODY = 512 * 1024;
/** the allocation sampler's interval while attributing GC: coarse on purpose (64 KB, against the
 *  16 KB the allocators table used) — the attribution needs shares, not every object, and every
 *  sample is a record V8 keeps until the read */
const GC_SAMPLING_BYTES = 65536;
/** the fine heap series (alloc.ts): the timer's period and the most samples one window keeps */
const HEAP_SERIES_PERIOD_MS = 20;
const HEAP_SERIES_MAX = 2000;
/** the sampler keeps objects already collected: the ALLOCATION stream, what drives the collector,
 *  not just what is still alive when the profile is read */
const GC_SAMPLING_FLAGS = { includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true };
/** how long a page profile waits for a background window (trap / sampler) to finish — the
 *  longest such window is the trap's 5 s */
const PAGE_WAITS_FOR_BACKGROUND_MS = 8000;
const MAX_VISITS_PER_PAGE = 5;
/** Svelte's client runtime, by the names that show up under a component while it hydrates */
/** the package in a CDN script's path: `/npm/@scope/name@8/dist/x.js`, `/name@1.2.3/x.js`, `/gh/user/repo@v/` */
const CDN_PKG_RE = /\/(?:npm\/)?((?:@[\w.-]+\/)?[\w.-]+)@[\w.^~-]+\//;
const SVELTE_CLIENT_FN_RE =
	/^(?:set_text|set_attribute|set_class|set_style|template|from_html|child|sibling|first_child|append|mount|hydrate|hydrate_template|each|if_block|render_effect|template_effect|effect|derived|proxy|get|set|push|pop|init|reset|next|skip_nodes|create_text|remove_nodes|event|delegate|bind_value|component|snippet|slot|head)$/;

/**
 * Chromium's JS Self-Profiling trace (`Profiler.stop()`) as a V8 cpuprofile: a stack is a chain of
 * frames, so every distinct stack becomes one node whose parent is its parent stack; the samples
 * are timestamps (ms) → time deltas (µs); a sample with no stack is idle. Bounded (samples,
 * stacks); `null` for anything not shaped like a trace. Exported for the tests.
 */
export function self_profile_to_cpuprofile(trace: unknown): CpuProfile | null {
	const t = trace as {
		resources?: unknown;
		frames?: unknown;
		stacks?: unknown;
		samples?: unknown;
	};
	if (!t || !Array.isArray(t.frames) || !Array.isArray(t.stacks) || !Array.isArray(t.samples)) return null;
	const resources = Array.isArray(t.resources) ? (t.resources as unknown[]).map((r) => (typeof r === 'string' ? r : '')) : [];
	const frames = (t.frames as { name?: unknown; resourceId?: unknown; line?: unknown; column?: unknown }[]).slice(0, 50_000);
	const stacks = (t.stacks as { frameId?: unknown; parentId?: unknown }[]).slice(0, 100_000);
	const samples = (t.samples as { timestamp?: unknown; stackId?: unknown }[]).slice(0, 200_000);
	const frame_of = (i: number): CallFrame => {
		const f = frames[i];
		if (!f) return { functionName: '(unknown)', url: '', lineNumber: 0, columnNumber: 0 };
		const rid = typeof f.resourceId === 'number' ? f.resourceId : -1;
		return {
			functionName: typeof f.name === 'string' ? f.name : '',
			url: rid >= 0 ? (resources[rid] ?? '') : '',
			lineNumber: typeof f.line === 'number' ? Math.max(0, f.line - 1) : 0,
			columnNumber: typeof f.column === 'number' ? Math.max(0, f.column - 1) : 0
		};
	};
	// node ids: 1 = (root), 2 = (idle), stack i → i + 3
	const nodes: ProfileNode[] = [
		{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 }, children: [2] },
		{ id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: 0, columnNumber: 0 } }
	];
	const children = new Map<number, number[]>([[1, [2]]]);
	for (let i = 0; i < stacks.length; i++) {
		const s = stacks[i];
		const fid = typeof s?.frameId === 'number' ? s.frameId : -1;
		const parent = typeof s?.parentId === 'number' && s.parentId >= 0 && s.parentId < stacks.length ? s.parentId + 3 : 1;
		nodes.push({ id: i + 3, callFrame: frame_of(fid) });
		(children.get(parent) ?? children.set(parent, []).get(parent)!).push(i + 3);
	}
	for (const n of nodes) {
		const ch = children.get(n.id);
		if (ch?.length) n.children = ch;
	}
	const sample_ids: number[] = [];
	const deltas: number[] = [];
	let last: number | null = null;
	let first = 0;
	for (const s of samples) {
		const ts = typeof s?.timestamp === 'number' ? s.timestamp : null;
		if (ts === null) continue;
		if (last === null) first = ts;
		const sid = typeof s?.stackId === 'number' && s.stackId >= 0 && s.stackId < stacks.length ? s.stackId + 3 : 2;
		sample_ids.push(sid);
		deltas.push(last === null ? 0 : Math.max(0, Math.round((ts - last) * 1000)));
		last = ts;
	}
	if (!sample_ids.length) return null;
	return { nodes, startTime: Math.round(first * 1000), endTime: Math.round((last ?? first) * 1000), samples: sample_ids, timeDeltas: deltas };
}
const MAX_BEACON_ISLANDS = 400;
/** the tag the runtime looks for: its content is the beacon endpoint */
const BEACON_META = 'ogygia-profiler-beacon';
/** an island fingerprint: 8–32 lowercase hex chars, checked without a regex (per beacon sample) */
function is_hex_id(s: string): boolean {
	if (s.length < 8 || s.length > 32) return false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
	}
	return true;
}

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
	/** each GC pause with its time on the profile's clock, kind and flags (who caused it: gc.ts) */
	gc_events: GcEvent[];
	/** allocation slices read from the sampling heap profiler while the window ran */
	gc_slices: AllocSlice[];
	gc_dict: Record<string, AllocSite>;
	io_ops: IoOp[];
	/** promises created in the window and who created them (a sampled attribution) */
	promises?: { count: number; top: { caller: string; share: number }[] };
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
	/** page mode: every run's window, for the per-run component split */
	runs?: { start: number; end: number }[];
	/** the used heap sampled finely, on the capture's clock (full windows) */
	heap_series?: HeapSample[];
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
/** the seed script in a rendered document (report time, one document: not a hot path) */
const SEED_SCRIPT_RE = /<script\b[^>]*type="application\/ogygia-page"[^>]*>([\s\S]*?)<\/script>/i;
const SRC_RELATIVE_RE = /(?:^|[/\\])src[/\\](.*)$/;
const BACKSLASH_G = /\\/g;
const PATH_SEP_RE = /[/\\]/;
const TRAILING_SLASH_RE = /\/$/;
/** a WebAssembly script "file" as V8 names it: `/wasm/00034eea`, `wasm://wasm/…` */
const WASM_FRAME_RE = /^(?:wasm:\/\/|\/wasm\/)|[/\\]wasm\/[0-9a-f]+$/;
/** a resolved caller that lives in node_modules or Kit's runtime source: the framework, not the app */
const FRAMEWORK_SOURCE_RE = /[/\\]node_modules[/\\]|(?:^|[/\\])runtime[/\\](?:server|app)[/\\]/;
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
	/** the browser's web vitals per page path (`/beacon`), the profiler user's own visits */
	readonly #vitals = new Map<string, { samples: VitalsSample[]; last: number }>();
	/** the app's own browser marks per page path, per name (`mark()` from ogygia/profiler/client) */
	readonly #marks = new Map<string, Map<string, { ms: number[]; errors: number; attr_keys: Set<string> }>>();
	/** the trap (catch the slow one) and the always-on sampler: their state */
	readonly #trap: ProfilerOptions['trap'] | null;
	readonly #client_cpu: boolean;
	/** the browser's CPU profile of hydration, per page path (the profiler user's latest visit) */
	readonly #client_cpus = new Map<string, { analysis: Analysis; at: number; sample_ms: number }>();
	/** the beacon's visits per page (the browser's picture of a page load), a few kept each */
	readonly #visits = new Map<string, Visit[]>();
	/** THE SINK: rows an ephemeral host posts out before it dies (see sink.ts) */
	readonly #sink = new SinkBuffer();
	#sink_url: string | null = null;
	#sink_key: string | null = null;
	#sink_every = 10_000;
	#sink_timer: ReturnType<typeof setInterval> | null = null;
	#sink_inflight = false;
	#sink_last: { at: number; ok: boolean; rows: number; error?: string } | null = null;
	#trap_caught = 0;
	#trap_running = false;
	#trap_timer: ReturnType<typeof setTimeout> | null = null;
	readonly #sample: ProfilerOptions['sample'] | null;
	readonly #sampled: SampledWindow[] = [];
	#sample_timer: ReturnType<typeof setTimeout> | null = null;
	#background_note: string | null = null;
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
	/** page profiles waiting for a background window to give the recorder back */
	#page_waiting = 0;
	/** the durable report store (SQLite/Redis/Postgres/custom), when configured — else null and the
	 *  in-memory map is all there is (the prior behaviour) */
	#store: import('./storage/index.js').ProfilerStore | null = null;
	#als: import('node:async_hooks').AsyncLocalStorage<Ctx> | null = null;
	#init_done: Promise<void> | null = null;
	/** Re-assert the `globalThis.fetch` patch before a profile (self-heal if it was replaced). */
	#ensure_net: (() => void) | null = null;
	/** wraps Kit's `event.fetch` (in-process same-origin dispatch) with the recorder, per attributed request */
	#wrap_event_fetch: (<F extends typeof globalThis.fetch>(f: F) => F) | null = null;

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
		this.#trap = options.trap && options.trap.over > 0 ? options.trap : null;
		if (options.store) {
			this.#store = options.store;
			// init may be sync-throwing (a driver, a bad path) or async-rejecting — guard both, and
			// never let a store problem break the profiler mount (it falls back to memory-only)
			(async () => this.#store!.init?.())().catch((e) => {
				console.error('[ogygia/profiler] store init failed; falling back to in-memory:', e);
				this.#store = null;
			});
		}
		this.#client_cpu = options.clientCpu !== false;
		if (options.sink?.url) {
			this.#sink_url = options.sink.url;
			this.#sink_key = options.sink.key ?? this.secret ?? null;
			this.#sink_every = Math.max(1000, options.sink.every ?? 10_000);
			// a long-lived host flushes on a timer; a serverless one flushes after each request (below)
			if (!Number.isFinite(serverless_work_budget_ms())) {
				this.#sink_timer = setInterval(() => void this.#sink_flush(), this.#sink_every);
				this.#sink_timer.unref?.();
			}
		}
		this.#sample = options.sample ? options.sample : null;
	}

	// ---- background: the trap and the always-on sampler ----------------------
	/** Arm the background recorders (once, from the first request). Both need a real server: on a
	 *  serverless host an instance lives for one request and the inspector is often unavailable. */
	#arm_background(): void {
		if (!this.#trap && !this.#sample) return;
		if (Number.isFinite(serverless_work_budget_ms())) {
			this.#background_note = 'trap / sampling are off on this serverless host (an instance lives for one request).';
			return;
		}
		if (this.#trap && !this.#trap_timer) this.#schedule_trap(1000);
		if (this.#sample && !this.#sample_timer) this.#schedule_sample((this.#sample.every ?? 60) * 1000);
	}

	#schedule_trap(delay_ms: number): void {
		this.#trap_timer = setTimeout(() => void this.#trap_cycle(), delay_ms);
		this.#trap_timer.unref?.();
	}

	#schedule_sample(delay_ms: number): void {
		this.#sample_timer = setTimeout(() => void this.#sample_cycle(), delay_ms);
		this.#sample_timer.unref?.();
	}

	/** One rolling trap window: sample coarsely, then keep the window only if a request in it blew
	 *  past the threshold. The slowest such request is the report's request; the timeline is its. */
	async #trap_cycle(): Promise<void> {
		const t = this.#trap!;
		this.#trap_timer = null;
		const keep = t.keep ?? 3;
		if (this.#trap_caught >= keep) return;
		// a page profile is waiting for the recorder: let it have it, come back after
		if (this.#page_waiting) return this.#schedule_trap(1000);
		if (!this.#try_acquire_recorder()) return this.#schedule_trap(2000); // a recording is on — later
		this.#trap_running = true;
		this.#recording_since = Date.now();
		try {
			const window_ms = t.window ?? 5000;
			const cap = await this.#capture_window(
				(t.interval ?? 10) * 1000,
				() => new Promise<void>((r) => setTimeout(r, window_ms)),
				{ light: true }
			);
			const slow = this.#ring
				.filter((e) => !e.internal && e.pt !== undefined && e.ts >= cap.t0 && e.ts + e.ms <= cap.t1 && e.ms >= t.over)
				.sort((x, y) => y.ms - x.ms)[0];
			if (slow) {
				cap.window = { start: slow.pt!, end: slow.pt! + slow.ms };
				const id = await this.#finish_report(cap, {
					trigger: 'trap',
					request: { method: slow.method, path: slow.path, route: slow.route, ms: slow.ms },
					trap_over: t.over
				});
				const stored = this.#reports.get(id);
				if (stored) stored.replay = { path: slow.path + (slow.search ?? ''), headers: slow.replay_headers ?? {} };
				// a catch on an ephemeral host is worth nothing in memory: the sink gets its dump
				if (stored && this.#sink_url) {
					this.#sink.push({ k: 'trap', t: stored.meta.created, path: slow.path, ms: slow.ms, id, dump: report_dump(stored.analysis, stored.meta, this.#report_extras(stored)) });
					void this.#sink_flush();
				}
				this.#trap_caught++;
			}
		} catch {
			// the inspector refused (another debugger, an unsupported host): stop trying
			this.#trap_caught = keep;
		} finally {
			this.#trap_running = false;
			this.#recording_since = 0;
			this.#release_als();
			this.#release_recorder();
		}
		if (this.#trap_caught < keep) this.#schedule_trap(1000);
	}

	/** One always-on sample: a short coarse window folded into the rolling hot-functions table. */
	async #sample_cycle(): Promise<void> {
		const s = this.#sample!;
		this.#sample_timer = null;
		const every_ms = (s.every ?? 60) * 1000;
		if (this.#page_waiting) return this.#schedule_sample(Math.min(every_ms, 2000));
		if (!this.#try_acquire_recorder()) return this.#schedule_sample(Math.min(every_ms, 5000));
		this.#trap_running = true; // same rule: no per-request context for a background window
		this.#recording_since = Date.now();
		try {
			const window_ms = s.window ?? 2000;
			const cap = await this.#capture_window(
				(s.interval ?? 10) * 1000,
				() => new Promise<void>((r) => setTimeout(r, window_ms)),
				{ light: true }
			);
			const resolver = await this.#make_resolver();
			const a = analyze(cap.profile, resolver);
			this.#sampled.push({
				at: cap.t0,
				ms: cap.duration_ms,
				busy_ms: a.busy_ms,
				functions: a.functions.slice(0, SAMPLED_FUNCTIONS_PER_WINDOW).map((f) => ({
					key: f.key,
					name: f.name,
					url: f.url,
					line: f.line,
					category: f.category,
					pkg: f.pkg,
					self_ms: f.self_ms
				}))
			});
			while (this.#sampled.length > MAX_SAMPLED_WINDOWS) this.#sampled.shift();
			if (this.#sink_url) {
				const w = this.#sampled[this.#sampled.length - 1];
				this.#sink.push({ k: 'win', t0: w.at, t1: w.at + w.ms, fns: w.functions.slice(0, 40).map((f) => ({ name: f.name, file: f.url, self_ms: f.self_ms, category: f.category })) });
			}
		} catch {
			// unsupported host: stop
			return;
		} finally {
			this.#trap_running = false;
			this.#recording_since = 0;
			this.#release_als();
			this.#release_recorder();
		}
		this.#schedule_sample(every_ms);
	}

	/** The always-on table: every kept window folded, hot functions by summed self time. */
	#sampled_summary(): SampledSummary | null {
		if (!this.#sample) return null;
		const by_key = new Map<string, SampledSummary['functions'][number]>();
		let sampled_ms = 0;
		let busy_ms = 0;
		for (const w of this.#sampled) {
			sampled_ms += w.ms;
			busy_ms += w.busy_ms;
			for (const f of w.functions) {
				const g = by_key.get(f.key);
				if (g) {
					g.self_ms = round2(g.self_ms + f.self_ms);
					g.windows++;
				} else by_key.set(f.key, { ...f, windows: 1 });
			}
		}
		return {
			every_s: this.#sample.every ?? 60,
			window_ms: this.#sample.window ?? 2000,
			windows: this.#sampled.length,
			since: this.#sampled[0]?.at ?? null,
			sampled_ms: round2(sampled_ms),
			busy_ms: round2(busy_ms),
			functions: [...by_key.values()].sort((x, y) => y.self_ms - x.self_ms).slice(0, 40)
		};
	}

	#collect_window(call: NetCall): void {
		if (this.#window_net && this.#window_net.length < MAX_WINDOW_NET) this.#window_net.push(call);
	}

	#init(): Promise<void> {
		return (this.#init_done ??= (async () => {
			this.#arm_background();
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
					const { install_net_capture, ensure_fetch_patched, wrap_event_fetch } = await import('./net.js');
					this.#wrap_event_fetch = wrap_event_fetch;
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

	async #capture_window(
		interval_us: number,
		work: () => Promise<void>,
		/** `light`: a background window — no stack capture per call, no heap sampling, no async-hooks
		 *  I/O tracking; the sampler and the net log only (what the trap / sampler can afford).
		 *  `gc_attr: false`: heap sampling as before (live objects only, one read at the end) —
		 *  no allocation-stream flags, no slices — the cheaper recording when GC attribution is
		 *  not wanted, and the control when measuring what the attribution itself costs. */
		opts: { light?: boolean; gc_attr?: boolean } = {}
	): Promise<WindowCapture> {
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
		// each pause with WHEN (performance.now clock), what kind, and the flags — joined later to
		// the allocations that filled the heap before it (gc.ts)
		const gc_raw: { start: number; ms: number; kind: number; flags: number }[] = [];
		const measures: { name: string; ms: number }[] = [];
		const ingest = (
			entries: ReadonlyArray<{ entryType: string; name: string; duration: number; startTime?: number; detail?: unknown }>
		) => {
			for (const e of entries) {
				if (e.entryType === 'gc') {
					gc_pauses.push(e.duration);
					const d = (e.detail ?? {}) as { kind?: number; flags?: number };
					if (gc_raw.length < 5000) gc_raw.push({ start: e.startTime ?? 0, ms: e.duration, kind: d.kind ?? 0, flags: d.flags ?? 0 });
				} else if (e.entryType === 'measure' && measures.length < 5000) {
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
		// ALLOCATION ON THE TIMELINE: the used heap read finely (a V8 statistic, no syscall, a few
		// µs) so the report can say WHEN the heap grew and what ran then (alloc.ts). A timer only
		// fires when the loop yields, so each interval is "between two awaits" — the samples
		// carry their true times, the analysis never assumes the period. Full windows only.
		const heap_series: { t: number; mb: number }[] = [];
		let heap_timer: ReturnType<typeof setInterval> | undefined;
		if (!opts.light) {
			try {
				const v8 = await import('node:v8');
				const sample_heap = () => {
					if (heap_series.length >= HEAP_SERIES_MAX) return;
					heap_series.push({ t: perf_hooks.performance.now(), mb: v8.getHeapStatistics().used_heap_size / 1048576 });
				};
				heap_timer = setInterval(sample_heap, HEAP_SERIES_PERIOD_MS);
				heap_timer.unref?.();
			} catch {
				// no v8 module (edge): no series
			}
		}

		this.#window_net = [];
		// capture the calling stack of each outbound I/O call for the duration of
		// the window (off otherwise — it costs a stack per call)
		const netmod = await import('./net.js').catch(() => null);
		if (!opts.light) netmod?.set_stack_capture(true);
		// SPANS (`span()` / `tag()` from ogygia/profiler): recorded only while this window runs.
		// A span rides the same async context as the fetch patch — the request it belongs to, and
		// for nesting a child store carrying the span's id (only during a recording, so the per-hop
		// cost of a second store never reaches an un-profiled request).
		const spans: SpanRecord[] = [];
		let span_seq = 0;
		const als = this.#als;
		// NESTING outside a request context: a span opened where no request is being attributed
		// (a handle in front of ogygia's, a background job) still needs its parent — a store of the
		// recording's own, alive only for this window
		const { AsyncLocalStorage: SpanALS } = await import('node:async_hooks');
		const span_als = new SpanALS<number>();
		const span_recorder: SpanRecorder = {
			begin: (name, attrs) => {
				const ctx = als?.getStore();
				const parent = ctx?.span ?? span_als.getStore();
				const rec: SpanRecord = {
					id: ++span_seq,
					name: String(name).slice(0, 120),
					start: perf_hooks.performance.now(),
					ms: -1,
					...(attrs ? { attrs: { ...attrs } } : {}),
					...(parent !== undefined ? { parent } : {}),
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
				return ctx && als ? als.run({ ...ctx, span: s.id }, fn) : span_als.run(s.id, fn);
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
		const iomod = opts.light ? null : await import('./async-io.js').catch(() => null);
		let io_rec = iomod ? await iomod.record_async_io() : null;

		let heap_head: HeapNode | null = null;
		try {
			await session.post('Profiler.enable');
			await session.post('Profiler.setSamplingInterval', { interval: interval_us });
			let heap_on = false;
			if (this.want_heap && !opts.light) {
				try {
					await session.post('HeapProfiler.enable');
					// objects already collected stay in the profile: the ALLOCATION stream (what drives the
					// collector), not just what is still alive when the profile is read
					if (opts.gc_attr !== false) {
						try {
							await session.post('HeapProfiler.startSampling', { samplingInterval: GC_SAMPLING_BYTES, ...GC_SAMPLING_FLAGS });
							heap_on = true;
						} catch {
							// a sampler left running by an interrupted recording (one per isolate): stop it, once
							try {
								await session.post('HeapProfiler.stopSampling');
								await session.post('HeapProfiler.startSampling', { samplingInterval: GC_SAMPLING_BYTES, ...GC_SAMPLING_FLAGS });
								heap_on = true;
							} catch (e) {
								if (process.env.OGYGIA_PROFILER_DEBUG) console.error('[ogygia/profiler] allocation sampling unavailable, GC attribution off:', e);
								await session.post('HeapProfiler.startSampling', { samplingInterval: 16384 });
							}
						}
					} else await session.post('HeapProfiler.startSampling', { samplingInterval: 16384 });
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

			// THE ALLOCATION STREAM: one sampling session across the window, read ONCE at the end.
			// Not read during the work, deliberately: every read of the sampling profile (a stop or a
			// getSamplingProfile) set off a major collection, and a dozen reads made the collector
			// being measured three times slower — the attribution would have reported the pauses it
			// caused. Who allocated comes from the one read; WHEN each pause fell and what was running
			// then comes from the pause events and the CPU profile (gc.ts joins them).
			const gc_slices: AllocSlice[] = [];
			const gc_dict: Record<string, AllocSite> = {};

			await work();
			// the work is done: a GC pause after this point is the recorder's own, not the app's
			const perf_end = perf_hooks.performance.now();

			const { profile } = await session.post('Profiler.stop');
			// only the window that STARTED sampling stops it: the sampler is one per isolate, and a
			// background window (trap, sampler — no heap) ending here would kill a page recording's
			if (this.want_heap && !opts.light) {
				try {
					const res = await session.post('HeapProfiler.stopSampling');
					heap_head = (res as { profile?: { head?: HeapNode } }).profile?.head ?? null;
					if (heap_on && heap_head) {
						const cur = heap_sites(heap_head, gc_dict);
						const bytes: Record<string, number> = {};
						for (const [k, v] of cur) if (v > 0) bytes[k] = v;
						gc_slices.push({ t0: 0, t1: round2(perf_end - perf_start), bytes });
					}
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
				gc_events: gc_raw.filter((g) => g.start >= perf_start && g.start <= perf_end).map((g) => ({ t: round2(g.start - perf_start), ms: round2(g.ms), kind: gc_kind(g.kind), flags: g.flags })),
				gc_slices,
				gc_dict,
				...(io_rec ? { promises: io_rec.promises() } : {}),
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
				perf_start,
				// the series on the capture's clock (ms from the profiler's start), inside the window only
				...(heap_series.length >= 3 ? { heap_series: heap_series.filter((h) => h.t >= perf_start && h.t <= perf_end).map((h) => ({ t: round2(h.t - perf_start), mb: h.mb })) } : {})
			};
		} finally {
			clearInterval(mem_timer);
			if (heap_timer) clearInterval(heap_timer);
			histogram.disable();
			set_span_recorder(null);
			span_als.disable(); // the recording's own nesting store: gone with the window
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

	/** URL → local client file, for the browser CPU profile (see client-files.ts); undefined off Node */
	async #client_file_finder(origin: string | undefined): Promise<((url: string) => string | undefined) | undefined> {
		try {
			const fs = await import('node:fs');
			const path = await import('node:path');
			const entry = process.argv[1] ? path.dirname(process.argv[1]) : undefined;
			const dirs = client_dir_candidates(entry, process.cwd(), path.join);
			return client_file_finder(origin, dirs, (p) => fs.existsSync(p), path.join);
		} catch {
			return undefined;
		}
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
			| 'trap_over'
			| 'cold'
		>,
		/** page mode on a built app: the app's own fetch, to weigh the islands' JS closures */
		fetch_url?: (url: string) => Promise<Response>
	): Promise<string> {
		const resolver = await this.#make_resolver();
		const heap = cap.heap ? analyze_heap(cap.heap) : null;
		const heap_components = cap.heap ? heap_by_component(cap.heap) : null;
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
			// a frame the sourcemap sends back INTO the framework (Kit's `load_data.js` behind its
			// `event.fetch`, a bundled dependency) is not the app's caller either — the next frame
			// of the call chain is
			if (FRAMEWORK_SOURCE_RE.test(file)) return undefined;
			return name ? `${name} (${file}:${line})` : `${file}:${line}`;
		};
		for (const c of cap.net) {
			const chain = (c.caller_chain ?? (c.caller_site ? [c.caller_site] : []))
				.map(resolve_caller)
				.filter((s): s is string => !!s);
			c.caller = chain[0] ?? c.caller;
			if (chain.length > 1) c.callers = chain;
			delete c.caller_site;
			delete c.caller_chain;
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
		const requests = this.#ring.filter((e) => e.ts + e.ms >= cap.t0 && e.ts <= cap.t1);
		// the island host wrappers read as their island (`ProductCard (island host)`), not as the
		// hash Svelte named their virtual file with
		const analysis = analyze(cap.profile, resolver, cap.call_counts, timeline_input, island_host_renamer(requests));
		const id = Math.random().toString(36).slice(2, 10);
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
		// WHO CAUSED THE GC: the pauses joined to the allocation slices (a light window has neither)
		let gc_attr: GcAttribution | undefined;
		if (cap.gc_slices?.length && (cap.gc_events?.length || Object.keys(cap.gc_dict ?? {}).length)) {
			try {
				// source maps FIRST: the sites' files and lines back to the source, the app caller each
				// names too, and the category from the true file — so the profiler's own allocations
				// (its heap reads, its stack captures) read as the profiler's and are left out
				if (resolver && cap.gc_dict) {
					const short = (u: string) => u.replace(/^file:\/\//, '').split('/').slice(-2).join('/');
					for (const site of Object.values(cap.gc_dict)) {
						const m = site.url ? resolver.resolve(site.url, site.line - 1, 0) : undefined;
						if (m) {
							site.url = m.source;
							site.line = m.line;
							const c = categorize({ functionName: site.name, url: m.source, lineNumber: m.line - 1, columnNumber: 0, scriptId: '' });
							if (site.category !== 'component' && c.category !== 'component') site.category = c.category;
						}
						if (site.caller_url && site.caller_name) {
							const c = resolver.resolve(site.caller_url, (site.caller_line ?? 1) - 1, 0);
							if (c) {
								site.caller = `${site.caller_name} (${short(c.source)}:${c.line})`;
								// a builtin called from the profiler's own code is the profiler's too
								if (site.category !== 'component' && categorize({ functionName: site.caller_name, url: c.source, lineNumber: 0, columnNumber: 0, scriptId: '' }).category === 'profiler') site.category = 'profiler';
							}
						}
					}
				}
				const first = cap.mem[0]?.heap_used;
				const last = cap.mem[cap.mem.length - 1]?.heap_used;
				const window_offset_ms = cap.window ? round2(cap.window.start - cap.perf_start) : 0;
				gc_attr = attribute_gc({
					slices: cap.gc_slices,
					events: cap.gc_events ?? [],
					dict: cap.gc_dict ?? {},
					window_ms: cap.duration_ms,
					// what was RUNNING when each pause fell: the CPU segments over the whole capture
					// (every run), else the profiled window's, shifted onto the capture's clock
					...(analysis.capture_cpu
						? { running: analysis.capture_cpu }
						: analysis.timeline
							? { running: analysis.timeline.segments.filter((s) => s.kind === 'cpu').map((s) => ({ t0: s.t0 + window_offset_ms, t1: s.t1 + window_offset_ms, label: s.label, category: s.category, file: s.file })) }
							: {}),
					...(first !== undefined && last !== undefined ? { retained_mb: last - first } : {})
				});
				gc_attr.window_offset_ms = window_offset_ms;
			} catch (e) {
				if (process.env.OGYGIA_PROFILER_DEBUG) console.error('[ogygia/profiler] GC attribution failed:', e);
				gc_attr = undefined;
			}
		}
		// AS IF THE PROFILER WERE NOT THERE: its own CPU frames and its share of the GC pauses are
		// measured, reported once, and taken out of the runs; the GC summary is the normalised one
		{
			const cpu_over = analysis.overhead_ms;
			const gc_over = gc_attr?.summary.overhead_ms ?? 0;
			const n = meta.runs?.length ?? 0;
			// per run: the profiler's CPU inside that run's window, plus its share of the GC pauses
			// that fell inside it — NOT a flat split of the total, which would charge a run for the
			// profiler's start-up scan of compiled code (hundreds of ms on a big process, before the
			// first render) or its final reads (after the last)
			const per_run = new Array(n).fill(0) as number[];
			const cpu_in_runs = analysis.overhead_by_run_ms ?? [];
			for (let i = 0; i < n; i++) per_run[i] += cpu_in_runs[i] ?? 0;
			if (gc_attr && cap.runs?.length) {
				for (const p of gc_attr.pauses) {
					const t_abs = cap.perf_start + p.t;
					const i = cap.runs.findIndex((r) => t_abs >= r.start && t_abs <= r.end);
					if (i !== -1) per_run[i] += p.ms_measured - p.ms;
				}
			}
			const in_runs = per_run.reduce((a, b) => a + b, 0);
			meta.overhead = {
				cpu_ms: round2(cpu_over),
				gc_ms: round2(gc_over),
				per_run_ms: n ? round2(in_runs / n) : 0,
				...(n ? { per_run: per_run.map(round2) } : {}),
				note: 'the profiler’s own CPU frames and its share of the GC pauses, taken out of every number in this report: each run loses exactly what fell inside it; the start-up scan of compiled code and the final reads sit outside the runs. The sampler’s own thread and the inspector’s are not visible from inside and are not taken out.'
			};
			if (n && in_runs > 0) {
				meta.runs_measured = [...meta.runs!];
				meta.runs = meta.runs!.map((r, i) => round2(Math.max(0, r - per_run[i])));
			}
		}
		const gc: GcSummary | null = gc_attr
			? { count: gc_attr.summary.count, total_ms: gc_attr.summary.total_ms, max_ms: gc_attr.summary.max_ms }
			: cap.gc_pauses.length
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
		let contents: Record<string, string[]> | undefined;
		if (fetch_url && !this.dev) {
			const urls: string[] = [];
			for (const r of island_rows_of(meta)) urls.push(r.module_url, ...r.hints);
			if (urls.length) weights = await weigh_urls(urls, fetch_url, this.#weights);
			// the readable source list behind each hashed chunk (the build's handoff)
			for (const u of new Set(urls)) {
				const inside = chunkContents(u);
				if (inside?.length) (contents ??= {})[u] = inside;
			}
		}
		// WHEN THE HEAP GREW and what ran then: the fine series joined to the CPU over the capture
		let alloc: AllocTimeline | undefined;
		if (cap.heap_series?.length) {
			try {
				const window_offset_ms = cap.window ? round2(cap.window.start - cap.perf_start) : 0;
				alloc = alloc_timeline({
					samples: cap.heap_series,
					...(analysis.capture_cpu
						? { running: analysis.capture_cpu }
						: analysis.timeline
							? { running: analysis.timeline.segments.filter((s) => s.kind === 'cpu').map((s) => ({ t0: s.t0 + window_offset_ms, t1: s.t1 + window_offset_ms, label: s.label, category: s.category, file: s.file })) }
							: {}),
					gc: (cap.gc_events ?? []).map((g) => ({ t: g.t, ms: g.ms })),
					...(cap.window ? { window: { offset_ms: window_offset_ms, ms: round2(cap.window.end - cap.window.start) } } : {})
				});
			} catch {
				alloc = undefined;
			}
		}
		// THE INSTANCE WAS NOT ALONE: the other requests that overlapped the profiled window(s)
		let contended: Contention | undefined;
		{
			const windows = cap.runs?.length ? cap.runs : cap.window ? [cap.window] : [];
			if (windows.length) {
				try {
					// the paths the render called on its own server: a ring entry there is the render
					// waiting on itself, and the report says so instead of calling it a stranger
					const self_paths = new Set<string>();
					for (const c of cap.net) {
						const at = c.url.indexOf('://');
						const rest = at === -1 ? c.url : c.url.slice(c.url.indexOf('/', at + 3));
						const q = rest.indexOf('?');
						self_paths.add(q === -1 ? rest : rest.slice(0, q));
					}
					contended = contention({
						requests: this.#ring,
						windows,
						own: this.#ring.filter((e) => e.internal && e.pt !== undefined && windows.some((w) => e.pt! >= w.start - 1 && e.pt! <= w.end)),
						self_paths
					});
				} catch {
					contended = undefined;
				}
			}
		}
		this.#reports.set(id, {
			meta,
			analysis,
			heap,
			heap_components,
			net: cap.net,
			spans: cap.spans,
			mem: cap.mem,
			measures: cap.measures,
			gc,
			io: cap.io_ops,
			...(cap.promises ? { promises: cap.promises } : {}),
			call_counts: cap.call_counts,
			raw,
			...(weights ? { weights } : {}),
			...(contents ? { contents } : {}),
			...(gc_attr ? { gc_attr } : {}),
			...(alloc ? { alloc } : {}),
			...(contended ? { contention: contended } : {})
		});
		this.#persist(this.#reports.get(id)!);
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
		// SameSite=Lax (not Strict): the login POST is a fetch and the follow-up to the profiler is a
		// navigation; behind a proxy/CDN (Amplify) a Strict cookie can be dropped on that hop, which
		// looked like "the password does nothing". Lax still isn't sent cross-site, and it's HttpOnly.
		// A one-year Max-Age so the session survives (it was a session cookie, lost on some setups).
		const age = token === '' ? '' : '; Max-Age=31536000';
		return `og_profiler=${token}; Path=${this.base}; HttpOnly; SameSite=Lax${secure}${clear}${age}`;
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
		// never let a CDN/edge cache this response — a cached login strips Set-Cookie and the session
		// silently never seats (a classic serverless/Amplify symptom: 200 ok, but you loop on login)
		res.headers.set('cache-control', 'no-store, private');
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
			replay: (id, c) => this.#replay(id, c),
			dashboard: (c) => this.#dashboard(c.url.searchParams.get('by')),
			run_page: (c) => this.#run_page(c),
			record_page: (c) => this.#record_page(c),
			reset: (c) => this.#reset(c),
			status: () => ({
				recording: this.#recorder_busy || this.#recording_active(),
				inflight: this.#inflight,
				rss_mb: Math.round(process.memoryUsage().rss / 1048576),
				reports: this.#reports.size
			}),
			login_props: (c) => ({
				base: this.base,
				next: this.#safe_next(c.url.searchParams.get('next'))
			}),
			login: (c) => this.#login(c),
			logout: (c) => this.#logout(c),
			upload: (c) => this.#upload(c),
			report_stored: (id) => this.#reports.get(id ?? ''),
			report_load: (id) => this.#report_load(id),
			list_stored: (limit) => this.#list_stored(limit),
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
			site: (c) => this.#site(c),
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
			...(cap.runs ? { runs: cap.runs } : {}),
			// EVERY resource the hooks saw, waits or not, open or not: what a gap on the timeline can
			// be named after ("pending: Immediate from drainQueue") — the sweep's own list is the
			// filtered one above
			pending: cap.io_ops
				.filter((o) => o.start <= w.end && o.start + Math.max(o.ms, 0) >= w.start)
				.map((o) => ({ start: o.start, end: o.open ? w.end : o.start + o.ms, label: o.caller ? `${o.type} from ${o.caller}` : o.type, kind: io_kind(o.type) })),
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
					phase: phase_of(c.caller),
					...(c.callers ? { callers: c.callers } : {}),
					...(c.timings ? { timings: c.timings } : {})
				})),
				...cap.io_ops
					.filter(
						(o) =>
							!o.open &&
							o.ms >= 0.5 &&
							o.type !== 'Immediate' &&
							o.type !== 'TickObject' &&
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
	/** THE DATA RIVER for a page report: the last run's calls on their load lanes, what each load's
	 *  source returns, what each island reads (the build's page keys), the seed's bytes per key. */
	async #river_for(stored: StoredReport, body: string, last_window: { start: number; end: number } | undefined): Promise<River | undefined> {
		const tl = stored.analysis.timeline;
		if (!tl) return undefined;
		const lanes = tl.lanes ?? [];
		if (!lanes.length && !stored.net.length) return undefined;
		// the keys each load returns, from its source (the lane's file, relative to src or the cwd)
		const read = await this.#source_reader();
		const lane_files = [...new Set(lanes.map((l) => l.file))];
		const river_lanes = lane_files.map((file) => {
			const src = read(file);
			return { file, keys: src ? load_return_keys(src) : null };
		});
		// the calls of the LAST run only (the window's calls span every run), on the lane that made them
		const calls = stored.net
			.filter((c) => !last_window || (c.start >= last_window.start && c.start <= last_window.end))
			.map((c) => {
				const text = [c.caller_site?.file ?? '', ...(c.callers ?? []), c.caller ?? ''].join(' ');
				const lane = load_lane_of(text)?.file ?? null;
				return { lane: lane && lane_files.includes(lane) ? lane : lane_files.find((f) => lane && (f.endsWith(lane) || lane.endsWith(f))) ?? null, label: `${c.method} ${c.url}`, ms: Math.max(c.ms, 0) + (c.body_ms ?? 0) };
			});
		// the islands and the page.data keys the build says each reads
		const by_entry = new Map<string, { name: string; keys: string[] | null }>();
		for (const r of island_rows_of(stored.meta)) {
			if (by_entry.has(r.entry)) continue;
			let keys: string[] | null = null;
			try {
				keys = islandPageKeys(r.entry);
			} catch {
				keys = null;
			}
			by_entry.set(r.entry, { name: island_name(r), keys });
		}
		// the seed's bytes per key (JSON lane; a devalue seed measures as nothing per key)
		const seed_m = SEED_SCRIPT_RE.exec(body);
		const seed = seed_m ? seed_key_bytes(seed_m[1]) : {};
		if (!calls.length && !Object.keys(seed).length && !by_entry.size) return undefined;
		return build_river({ calls, lanes: river_lanes, islands: [...by_entry.values()], seed });
	}

	/** A reader of app sources at report time (a file relative to `src/` or the cwd, or absolute);
	 *  undefined where there is no file system, or when the file is not on this machine. */
	async #source_reader(): Promise<(file: string) => string | undefined> {
		let fs: typeof import('node:fs') | undefined;
		let path: typeof import('node:path') | undefined;
		try {
			fs = await import('node:fs');
			path = await import('node:path');
		} catch {
			fs = undefined;
		}
		const cache = new Map<string, string | undefined>();
		return (file: string): string | undefined => {
			if (!fs || !path) return undefined;
			if (cache.has(file)) return cache.get(file);
			const candidates = file.startsWith('/') ? [file] : [path.join(process.cwd(), 'src', file), path.join(process.cwd(), file)];
			let out: string | undefined;
			for (const c of candidates) {
				try {
					out = fs.readFileSync(c, 'utf8');
					break;
				} catch {
					/* next */
				}
			}
			cache.set(file, out);
			return out;
		};
	}

	/** DATA LINEAGE FROM THE CODE (lineage.ts): the route's page and layouts, every component the
	 *  profile saw with a `.svelte` source on this machine, and the islands (their keys from the
	 *  build), each with the page.data keys it reads — joined to the loads' keys and the seed. */
	async #lineage_for(stored: StoredReport, body: string): Promise<Lineage | undefined> {
		const a = stored.analysis;
		const tl = a.timeline;
		const read = await this.#source_reader();
		const lanes = tl?.lanes ?? [];
		const lane_files = [...new Set(lanes.map((l) => l.file))];
		// the waiting behind each lane: its calls in the whole recording, per render
		const runs = Math.max(stored.meta.runs?.length ?? 1, 1);
		const wait_by_lane = new Map<string, number>();
		for (const c of stored.net) {
			const text = [c.caller_site?.file ?? '', ...(c.callers ?? []), c.caller ?? ''].join(' ');
			const lane = load_lane_of(text)?.file;
			if (!lane) continue;
			const file = lane_files.includes(lane) ? lane : lane_files.find((f) => f.endsWith(lane) || lane.endsWith(f));
			if (!file) continue;
			wait_by_lane.set(file, (wait_by_lane.get(file) ?? 0) + (Math.max(c.ms, 0) + (c.body_ms ?? 0)) / runs);
		}
		const lineage_lanes = lane_files.map((file) => {
			const src = read(file);
			return { file, keys: src ? load_return_keys(src) : null, ...(wait_by_lane.has(file) ? { wait_ms: round2(wait_by_lane.get(file)!) } : {}) };
		});
		// the files to scan: the route's page + layouts (from the lanes' folders, up to `routes/`),
		// then every component the profile saw with a readable `.svelte` source
		const files = new Map<string, { name: string; island: boolean }>();
		const route_dirs = new Set<string>();
		for (const f of lane_files) {
			const at = f.lastIndexOf('/');
			if (at === -1) continue;
			let dir = f.slice(0, at);
			while (dir) {
				route_dirs.add(dir);
				const up = dir.lastIndexOf('/');
				if (up === -1 || dir === 'routes') break;
				dir = dir.slice(0, up);
			}
		}
		for (const dir of route_dirs) {
			for (const leaf of ['+page.svelte', '+layout.svelte']) {
				const file = `${dir}/${leaf}`;
				if (read(file) !== undefined && !files.has(file)) files.set(file, { name: `${dir.slice(dir.lastIndexOf('/') + 1)}/${leaf}`, island: false });
			}
		}
		// one spelling per file: the profile says `src/lib/X.svelte`, the lanes `routes/x/+page.svelte`
		const norm = (f: string) => (f.startsWith('src/') ? f.slice(4) : f);
		for (const c of a.components) {
			if (!c.url.endsWith('.svelte')) continue;
			const file = norm(c.url);
			if (files.has(file)) continue;
			if (read(file) !== undefined) files.set(file, { name: c.name, island: false });
		}
		// the islands: what the page's own seed explainer recorded (the runtime's answer per key:
		// which islands read it, which read the page whole), else the build's map (null: the whole
		// object), else a scan of the entry
		const seed_stats = stored.meta.requests.find((r) => r.og?.seed)?.og?.seed;
		const seen_entries = new Set<string>();
		const islands: { name: string; file: string; island: true; reads: string[] | null }[] = [];
		for (const r of island_rows_of(stored.meta)) {
			if (seen_entries.has(r.entry)) continue;
			seen_entries.add(r.entry);
			const name = island_name(r);
			let keys: string[] | null | undefined;
			if (seed_stats) {
				keys = seed_stats.keys.filter((k) => k.readers.includes(name)).map((k) => k.key);
				if (seed_stats.whole_by.includes(name)) keys.push('*');
			} else {
				try {
					keys = islandPageKeys(r.entry);
				} catch {
					keys = undefined;
				}
				if (keys === undefined) {
					const src = read(r.entry);
					keys = src ? data_reads(src, data_prop_names(src)) : null;
				} else if (keys === null) keys = ['*'];
			}
			islands.push({ name, file: norm(r.entry), island: true, reads: keys });
			// an island's entry is not a server component to scan on its own
			files.delete(norm(r.entry));
		}
		const components = [...files.entries()].map(([file, info]) => {
			const src = read(file)!;
			return { name: info.name, file, island: false, reads: data_reads(src, data_prop_names(src)) };
		});
		if (!components.length && !islands.length) return undefined;
		const seed_m = SEED_SCRIPT_RE.exec(body);
		const seed = seed_m ? seed_key_bytes(seed_m[1]) : {};
		return build_lineage({ components: [...components, ...islands], lanes: lineage_lanes, seed });
	}

	/** One more render under a LIVE-objects sampler (no collected-objects flag), then a full
	 *  collection, then the profile: every sampled object still alive was allocated by that
	 *  render and kept by something — the leak, by allocation site. Its own session, after the
	 *  runs, so nothing here is charged to them; the sites are source-mapped like the makers. */
	async #retention_pass(render: () => Promise<void>): Promise<Retained | undefined> {
		const { Session } = await import('node:inspector/promises');
		const session = new Session();
		session.connect();
		try {
			await session.post('HeapProfiler.enable');
			await session.post('HeapProfiler.startSampling', { samplingInterval: GC_SAMPLING_BYTES });
			const t = performance.now();
			await render();
			const render_ms = round2(performance.now() - t);
			await session.post('HeapProfiler.collectGarbage');
			const res = (await session.post('HeapProfiler.getSamplingProfile')) as { profile?: { head?: HeapNode } };
			await session.post('HeapProfiler.stopSampling');
			const head = res.profile?.head;
			if (!head) return undefined;
			const dict: Record<string, AllocSite> = {};
			const sites = heap_sites(head, dict);
			const resolver = await this.#make_resolver();
			const short = (u: string) => u.replace(/^file:\/\//, '').split('/').slice(-2).join('/');
			// one row per allocation line (the same builtin from several stacks is one site)
			const by_ident = new Map<string, RetainedSite>();
			let total = 0;
			for (const [key, bytes] of sites) {
				const d = dict[key];
				if (!d || d.category === 'profiler' || d.category === 'v8' || d.category === 'gc') continue;
				let url = d.url;
				let line = d.line;
				let caller = d.caller;
				if (resolver) {
					const m = url ? resolver.resolve(url, line - 1, 0) : undefined;
					if (m) {
						url = m.source;
						line = m.line;
					}
					if (d.caller_url && d.caller_name) {
						const c = resolver.resolve(d.caller_url, (d.caller_line ?? 1) - 1, 0);
						if (c) caller = `${d.caller_name} (${short(c.source)}:${c.line})`;
					}
				}
				const ident = `${d.name}|${url}|${line}|${caller ?? ''}`;
				const row = by_ident.get(ident) ?? { name: d.name, url, line, ...(caller ? { caller } : {}), component: d.component, bytes: 0, share: 0 };
				row.bytes += bytes;
				by_ident.set(ident, row);
				total += bytes;
			}
			const rows = [...by_ident.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 30);
			for (const r of rows) r.share = total ? round2(r.bytes / total) : 0;
			return { total_bytes: total, render_ms, sites: rows };
		} finally {
			try {
				session.disconnect();
			} catch {
				// already gone
			}
		}
	}

	#compare(a: string | undefined, b: string | undefined) {
		const A = this.#reports.get(a ?? '');
		const B = this.#reports.get(b ?? '');
		// one (or both) gone from this server — restarted, or an ephemeral host: the compare page
		// then builds the comparison from the browser's own store
		if (!A || !B) return { base: this.base, cmp: null, a: a ?? '', b: b ?? '' };
		const pack = (s: StoredReport) => ({
			meta: s.meta,
			analysis: s.analysis,
			findings: derive_findings(s.analysis, s.meta, this.#report_extras(s)).map(
				(f) => `${f.code}: ${f.message}`
			),
			...(s.gc_attr ? { gc: s.gc_attr } : {})
		});
		return { base: this.base, cmp: compare_reports(pack(A), pack(B)), a: A.meta.id, b: B.meta.id };
	}

	/** DEV ONLY: nine lines of a local source file around `l` — the source peek an expanded row
	 *  shows. Behind the login like every route; the path must resolve inside the project (the
	 *  process cwd, symlinks followed) and be a source file. Anything else is a 404. */
	async #source(ctx: RouteCtx): Promise<Response> {
		if (!this.dev) return new Response('Not found', { status: 404 });
		const p = ctx.url.searchParams.get('p') ?? '';
		const line = Math.max(1, Number(ctx.url.searchParams.get('l')) || 1);
		// `to`: widen the peek to cover the hot lines (capped so a whole file never ships)
		const to = Math.min(line + 60, Math.max(line, Number(ctx.url.searchParams.get('to')) || line));
		try {
			const fs = await import('node:fs');
			const path = await import('node:path');
			const real = fs.realpathSync(p);
			const root = fs.realpathSync(process.cwd());
			if (!real.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
			if (!SOURCE_EXT_RE.test(real)) return new Response('Not found', { status: 404 });
			const lines = fs.readFileSync(real, 'utf8').split('\n');
			const start = Math.max(1, line - 4);
			const end = Math.min(lines.length, to + 4);
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
			history: page_history([...this.#reports.values()].map((r) => r.meta)),
			trap: this.#trap
				? {
						over: this.#trap.over,
						window_ms: this.#trap.window ?? 5000,
						caught: this.#trap_caught,
						keep: this.#trap.keep ?? 3,
						armed: !!this.#trap_timer || this.#trap_running
					}
				: null,
			sampled: this.#sampled_summary(),
			background_note: this.#background_note
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
	async #record_page(ctx: RouteCtx, replay?: { path: string; headers: Record<string, string> }): Promise<Response> {
		const event = ctx.event!; // event.fetch (Kit's internal SSR render) is the one thing only Kit gives
		// One recording per worker (shared inspector). A BACKGROUND window (the trap, the sampler)
		// holding it yields: it is short, and it will not re-arm while a page profile waits — so wait
		// for it here (a few seconds at most) rather than bounce. Another PAGE recording is the real
		// conflict: refuse immediately with a 409 the client retries — don't hold a waiter in memory
		// (unreliable on a worker that may be recycled within 30 s). The retry lands on a free worker
		// (serverless) or comes back once this one finishes (single server). Reset clears a wedged one.
		if (this.#recorder_busy && this.#trap_running) {
			this.#page_waiting++;
			try {
				const until = Date.now() + PAGE_WAITS_FOR_BACKGROUND_MS;
				while (this.#recorder_busy && this.#trap_running && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
			} finally {
				this.#page_waiting--;
			}
		}
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
			const path = replay?.path ?? q.get('p') ?? '';
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
					event.fetch(p, { headers: { ...(replay?.headers ?? {}), 'x-og-profiler-internal': '1' } }),
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
			// THE COLD START: the first warm-up render pays module load + compile — profiled on its own
			// (a light window: sampler only) so the report can show what that first render cost per
			// file against the warm renders. `?cold=0` skips it.
			let cold_cap: WindowCapture | undefined;
			const want_cold = q.get('cold') !== '0';
			for (let hop = 0; hop < 5; hop++) {
				const t = performance.now();
				let res: Response | undefined;
				try {
					if (hop === 0 && want_cold) {
						cold_cap = await this.#capture_window(
							interval,
							async () => {
								res = await fetch_render(target);
							},
							{ light: true }
						);
					} else res = await fetch_render(target);
				} catch {
					break; // warm-up failure surfaces on the real runs below
				}
				if (!res) break;
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
			let last_body = '';
			let last_chunks: { end: number; t: number }[] = [];
			let budget_note: string | undefined;
			// Reserve room for the coverage pass (call counts — "traverse ×768k") so a slow page can never
			// consume the whole budget on CPU runs and starve it. One render ≈ the warm-up's wall time.
			const coverage_reserve = Math.max(warmup_ms ?? 0, 300);
			// `?gc=0`: record without the GC attribution (no allocation-stream sampling, no reads) — the
			// cheaper recording, and the control for what the attribution costs
			const gc_attr = q.get('gc') !== '0';
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
					// the body read chunk by chunk, each stamped: when each part of the document LEFT the
					// server (the byte strip draws it; a streamed page shows what held its first bytes)
					const { text: body, chunks } = await read_timed(res, t);
					const done = performance.now();
					run_status = res.status;
					run_bytes = body.length;
					last_body = body;
					last_chunks = chunks;
					run_ms.push(round2(done - t));
					run_windows.push({ start: t, end: done });
					// let the event loop turn once between renders: flushes the GC
					// PerformanceObserver (its entries arrive on a macrotask) and keeps
					// each render a clean, separately-attributed unit
					await new Promise((r) => setImmediate(r));
				}
			}, { gc_attr });
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
			cap.runs = run_windows; // every run's window: the per-run component split
			// the cold render's per-file cost (the warm figures come from the main analysis at report time)
			let cold: ReportMeta['cold'];
			if (cold_cap && warmup_ms !== undefined) {
				try {
					const a0 = analyze(cold_cap.profile, await this.#make_resolver());
					cold = {
						ms: warmup_ms,
						busy_ms: a0.busy_ms,
						files: a0.files
							.filter((f) => f.category !== 'idle' && f.category !== 'gc' && f.category !== 'profiler' && f.self_ms >= 0.5)
							.slice(0, 40)
							.map((f) => ({ file: f.key, category: f.category, ms: f.self_ms }))
					};
				} catch {
					cold = undefined;
				}
			}
			// call counts come from ONE extra render under precise coverage — a
			// SEPARATE pass, because coverage stops V8 inlining and would otherwise
			// inflate the CPU profile (svelte's hot `child`/`push` would dominate).
			// Always run it (the ×N counts are the point) — the loop above reserved its time.
			// WHAT A RENDER LEAVES BEHIND: one more render under a live-objects sampler, a full
			// collection, then what is still alive by allocation site — outside the runs, and only
			// when the budget has room for another render
			let retained: Retained | undefined;
			if (gc_attr && this.want_heap && Date.now() + (warmup_ms ?? 0) * 2 + 500 < deadline) {
				try {
					retained = await this.#retention_pass(async () => {
						await fetch_render(target).then((r) => r.text());
					});
				} catch {
					retained = undefined;
				}
			}
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
					runs: run_ms,
					...(cold ? { cold } : {})
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
			if (retained) s.retained = retained;
			// THE DOCUMENT AS BYTES and THE DATA RIVER, from the last run's body
			if (last_body) {
				try {
					s.strip = byte_strip(last_body);
					if (last_chunks.length > 1) s.strip.chunks = last_chunks;
				} catch {
					// a document the scanner cannot walk: no strip
				}
				try {
					s.river = await this.#river_for(s, last_body, run_windows[run_windows.length - 1]);
				} catch {
					// no river
				}
				try {
					s.lineage = await this.#lineage_for(s, last_body);
				} catch {
					// no lineage
				}
			}
			// `keep`: the run page asks for the report's dump in the answer so the BROWSER keeps it
			// (IndexedDB) — on an ephemeral host the instance that rendered it is gone before the
			// report page is opened, and a persistent one may restart
			if (q.get('format') === 'keep') {
				return ctx.json({ id, url: ctx.href('/report/[id]', { id }), dump: report_dump(s.analysis, s.meta, this.#report_extras(s)) });
			}
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
		this.#reports.set(id, this.#report_from_dump({ ...dump, meta: { ...dump.meta, id } }));
		while (this.#reports.size > this.max_reports) {
			const oldest = this.#reports.keys().next().value;
			if (oldest === undefined) break;
			this.#reports.delete(oldest);
		}
		return id;
	}

	/** A StoredReport rebuilt from a portable dump (an uploaded `.ogp`, or one read back from the
	 *  storage backend). No cpuprofile survives a dump, so `raw` is empty (the `/raw` link 404s). */
	#report_from_dump(dump: { analysis: Analysis; meta: ReportMeta; extras: ReportExtras }): StoredReport {
		const e = dump.extras;
		return {
			meta: dump.meta,
			analysis: dump.analysis,
			heap: e.heap,
			...(e.heap_components ? { heap_components: e.heap_components } : {}),
			net: e.net,
			mem: e.mem,
			measures: e.measures ?? [],
			gc: e.gc ?? null,
			io: e.io ?? [],
			call_counts: e.call_counts ?? {},
			raw: '',
			...(e.weights ? { weights: e.weights } : {}),
			...(e.contents ? { contents: e.contents } : {}),
			...(e.client ? { client: e.client } : {}),
			...(e.vitals ? { vitals: e.vitals } : {}),
			...(e.client_marks ? { client_marks: e.client_marks } : {}),
			...(e.client_cpu ? { client_cpu: e.client_cpu } : {}),
			...(e.alloc ? { alloc: e.alloc } : {}),
			...(e.contention ? { contention: e.contention } : {}),
			...(e.lineage ? { lineage: e.lineage } : {}),
			// the fields the dump carries that were being dropped on reload — the GC attribution, the
			// data river, the document strip, what a render retains, the spans, the visit
			...(e.spans ? { spans: e.spans } : {}),
			...(e.visit ? { visit: e.visit } : {}),
			...(e.strip ? { strip: e.strip } : {}),
			...(e.river ? { river: e.river } : {}),
			...(e.gc_attr ? { gc_attr: e.gc_attr } : {}),
			...(e.promises ? { promises: e.promises } : {}),
			...(e.retained ? { retained: e.retained } : {})
		};
	}

	/** Write a finished report to the durable store, when one is configured (fire-and-forget; a store
	 *  failure never fails the recording). The dump is the same portable JSON the `.ogp` export uses. */
	#persist(stored: StoredReport): void {
		if (!this.#store) return;
		const meta = stored.meta;
		const median = meta.runs?.length ? [...meta.runs].sort((a, b) => a - b)[Math.floor(meta.runs.length / 2)] : null;
		const rec = {
			id: meta.id,
			created: meta.created,
			page: meta.page ?? null,
			trigger: meta.trigger,
			label: meta.page ?? meta.request?.path ?? meta.id,
			median,
			dump: JSON.stringify(report_dump(stored.analysis, meta, this.#report_extras(stored)))
		};
		Promise.resolve()
			.then(async () => {
				await this.#store!.putReport(rec);
				await this.#store!.prune?.(Math.max(this.max_reports * 8, 200));
			})
			.catch((err) => {
				if (process.env.OGYGIA_PROFILER_DEBUG) console.error('[ogygia/profiler] store.putReport failed:', err);
			});
	}

	/** Memory first, then the durable store: read the dump back, reconstruct, cache in memory. */
	async #report_load(id: string | undefined): Promise<StoredReport | undefined> {
		if (!id) return undefined;
		const hit = this.#reports.get(id);
		if (hit) return hit;
		if (!this.#store) return undefined;
		try {
			const json = await this.#store.getReport(id);
			if (!json) return undefined;
			const dump = JSON.parse(json) as { analysis: Analysis; meta: ReportMeta; extras: ReportExtras };
			if (!dump?.meta || !dump.analysis) return undefined;
			const stored = this.#report_from_dump({ ...dump, meta: { ...dump.meta, id } });
			this.#reports.set(id, stored); // warm the hot cache
			return stored;
		} catch (err) {
			if (process.env.OGYGIA_PROFILER_DEBUG) console.error('[ogygia/profiler] store.getReport failed:', err);
			return undefined;
		}
	}

	/** The reports the durable store holds (summaries), newest first — the sidebar's shared list. */
	async #list_stored(limit = 20): Promise<{ id: string; label: string; page?: string; created: number }[]> {
		if (!this.#store) return [];
		try {
			const rows = await this.#store.listReports(limit);
			return rows.map((r) => ({ id: r.id, label: r.label, page: r.page ?? undefined, created: r.created }));
		} catch {
			return [];
		}
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
		const vitals = stored.vitals ?? this.#vitals_for(stored.meta.page);
		const client_marks = stored.client_marks ?? this.#marks_for(stored.meta.page);
		const client_cpu = stored.client_cpu ?? (stored.meta.page ? this.#client_cpus.get(stored.meta.page) : undefined);
		const visit = stored.visit ?? (stored.meta.page ? this.#visits.get(stored.meta.page)?.at(-1) : undefined);
		return {
			...(visit ? { visit } : {}),
			...(stored.strip ? { strip: stored.strip } : {}),
			...(stored.river ? { river: stored.river } : {}),
			...(stored.gc_attr ? { gc_attr: stored.gc_attr } : {}),
			...(stored.promises ? { promises: stored.promises } : {}),
			...(stored.retained ? { retained: stored.retained } : {}),
			...(stored.alloc ? { alloc: stored.alloc } : {}),
			...(stored.contention ? { contention: stored.contention } : {}),
			...(stored.lineage ? { lineage: stored.lineage } : {}),
			net: stored.net,
			spans: stored.spans ?? [],
			heap: stored.heap,
			...(stored.heap_components ? { heap_components: stored.heap_components } : {}),
			mem: stored.mem,
			measures: stored.measures,
			gc: stored.gc,
			io: stored.io,
			call_counts: stored.call_counts,
			...(stored.weights ? { weights: stored.weights } : {}),
			...(stored.contents ? { contents: stored.contents } : {}),
			...(client.length ? { client } : {}),
			...(vitals ? { vitals } : {}),
			...(client_marks?.length ? { client_marks } : {}),
			...(client_cpu ? { client_cpu } : {}),
			...(stored.replay ? { replay: stored.replay } : {})
		};
	}

	/** The app's own browser marks for the page, per name (p50 / max over the visits). */
	#marks_for(page: string | undefined): ClientMarkStat[] | undefined {
		if (!page) return undefined;
		const by_name = this.#marks.get(page);
		if (!by_name?.size) return undefined;
		const out: ClientMarkStat[] = [];
		for (const [name, a] of by_name) {
			const ms = [...a.ms].sort((x, y) => x - y);
			out.push({ name, n: ms.length, p50_ms: round2(percentile(ms, 0.5)), max_ms: round2(ms[ms.length - 1] ?? 0), errors: a.errors, attr_keys: [...a.attr_keys].sort() });
		}
		return out.sort((x, y) => y.p50_ms - x.p50_ms);
	}

	/** The page's web vitals as the profiler user's browser reported them (p50 over the visits). */
	#vitals_for(page: string | undefined): PageVitals | undefined {
		if (!page) return undefined;
		const e = this.#vitals.get(page);
		if (!e || !e.samples.length) return undefined;
		const p50 = (k: keyof VitalsSample) => {
			const xs = e.samples.map((s) => s[k]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
			return xs.length ? round2(percentile(xs, 0.5)) : null;
		};
		return { n: e.samples.length, ttfb: p50('ttfb'), fcp: p50('fcp'), lcp: p50('lcp'), cls: p50('cls'), inp: p50('inp') };
	}

	/** The browser's hydration timings for THIS report's islands: the beacon ring joined by
	 *  fingerprint (the same props → the same fingerprint, so a visit after the recording matches),
	 *  then merged per island — a list of 48 cards is 48 fingerprints and one row. */
	#client_for(stored: StoredReport): ClientIslandStat[] {
		const per_entry = new Map<string, { fp: string; name: string; ms: number[]; load: number[]; recovered: number; reason?: string }>();
		for (const r of island_rows_of(stored.meta)) {
			const b = this.#beacons.get(r.fp);
			if (!b || !b.ms.length) continue;
			let e = per_entry.get(r.entry);
			if (!e) per_entry.set(r.entry, (e = { fp: r.fp, name: r.name, ms: [], load: [], recovered: 0 }));
			e.ms.push(...b.ms);
			e.load.push(...b.load);
			e.recovered += b.recovered;
			if (b.reason) e.reason = b.reason;
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
				load_p50_ms: round2(percentile(load, 0.5)),
				recovered: e.recovered,
				...(e.reason ? { reason: e.reason } : {})
			});
		}
		return out;
	}

	/** `/replay/[id]`: profile a caught (or header-profiled) request again, in full page mode, with
	 *  the inputs it was caught with — its path and query, and the headers the trap config kept. */
	async #replay(id: string | undefined, ctx: RouteCtx): Promise<Response> {
		const stored = this.#reports.get(id ?? '');
		if (!stored?.meta.request) return new Response('Nothing to replay: that report has no request.', { status: 404 });
		const replay = stored.replay ?? { path: stored.meta.request.path, headers: {} };
		return this.#record_page(ctx, replay);
	}

	/** The browser's CPU profile (Chromium's JS Self-Profiling trace) → the same analysis as the
	 *  server's: components, functions, flame. Categories come from the chunk contents the build
	 *  recorded, since a client chunk's URL says nothing about what it holds. */
	async #ingest_client_cpu(page: string, trace: unknown, origin?: string): Promise<boolean> {
		const profile = self_profile_to_cpuprofile(trace);
		if (!profile) return false;
		// THE APP'S OWN SCRIPTS BY THEIR LOCAL FILE: the browser names a frame by URL; its source map
		// sits next to the built client file. Rewriting the URL to that file (when it exists) lets the
		// server's resolver map browser frames the same way — real names for minified ones, the
		// `.svelte` file for a component. A chunk with no local file keeps its URL.
		const find = await this.#client_file_finder(origin);
		let rewritten = 0;
		if (find) {
			for (const n of profile.nodes) {
				const file = find(n.callFrame.url);
				if (file) {
					n.callFrame.url = file;
					rewritten++;
				}
			}
		}
		const resolver = rewritten ? await this.#make_resolver() : undefined;
		const url_hint = (url: string, name: string): FrameCategory | { category: FrameCategory; pkg?: string } | undefined => {
			let path: string;
			try {
				const u = new URL(url, 'http://x');
				path = u.pathname;
				// a script from another host (a CDN's web components, a tag manager) is a dependency,
				// whatever its function names look like — named by the package in its path, else the host
				if (origin && u.host !== 'x' && u.origin !== origin) return { category: 'dependency', pkg: CDN_PKG_RE.exec(path)?.[1] ?? u.host };
			} catch {
				return undefined;
			}
			// the handoff keys chunks by their served path; a rewritten local file still carries it
			const rel = app_asset_rel(path);
			if (rel) path = '/' + rel;
			const inside = chunkContents(path);
			if (inside) {
				if (inside.every((s) => s === 'svelte runtime')) return 'svelte';
				// a chunk with none of the app's own files in it (runtimes, packages) is a dependency,
				// whatever its minified functions are called — named by what is in it
				if (!inside.some((s) => s.startsWith('src/') || s.endsWith('.svelte') || s.startsWith('+'))) {
					const pkgs = inside.map((s) => s.replace(/ runtime$/, '')).filter((s) => !s.startsWith('+'));
					return { category: 'dependency', pkg: pkgs.length > 2 ? `${pkgs[0]} +${pkgs.length - 1}` : pkgs.join(' + ') };
				}
				return undefined;
			}
			// no handoff (dev, an unknown chunk): Svelte's client runtime by its function names, so a
			// component above them is still confirmed as one
			return SVELTE_CLIENT_FN_RE.test(name) ? 'svelte' : undefined;
		};
		// a confirmed component still wearing a minified name (no map) is named from the .svelte files in its chunk
		const analysis = analyze(profile, resolver, undefined, undefined, chunk_component_renamer(chunkContents), url_hint);
		if (this.#client_cpus.size >= 50 && !this.#client_cpus.has(page)) this.#client_cpus.delete(this.#client_cpus.keys().next().value!);
		this.#client_cpus.set(page, { analysis, at: Date.now(), sample_ms: analysis.duration_ms });
		return true;
	}

	/** `/beacon` (POST, authed): the runtime's hydration timings — `{ islands: [{ fp, entry, ms, load }] }`.
	 *  Bounded every way (body, islands per post, fingerprints kept, samples per fingerprint). */
	async #beacon(ctx: RouteCtx): Promise<Response> {
		let body: unknown;
		try {
			const text = await ctx.request.text();
			// a CPU trace is the one big body (samples + stacks); a visit is a few hundred resources;
			// everything else stays small
			if (text.length > (text.includes('"cpu"') ? MAX_BEACON_CPU_BODY : text.includes('"visit"') ? MAX_BEACON_VISIT_BODY : MAX_BEACON_BODY)) return new Response(null, { status: 413 });
			body = JSON.parse(text);
		} catch {
			return new Response(null, { status: 400 });
		}
		const islands = (body as { islands?: unknown })?.islands;
		const vitals = (body as { vitals?: unknown })?.vitals;
		const marks = (body as { marks?: unknown })?.marks;
		const cpu = (body as { cpu?: unknown })?.cpu;
		const page = (body as { page?: unknown })?.page;
		const visit_raw = (body as { visit?: unknown })?.visit;
		if (!Array.isArray(islands) && !(vitals && typeof vitals === 'object') && !Array.isArray(marks) && !(cpu && typeof cpu === 'object') && !(visit_raw && typeof visit_raw === 'object')) return new Response(null, { status: 400 });
		// THE VISIT: the browser's whole picture of one page load, a few kept per page
		if (visit_raw && typeof visit_raw === 'object') {
			const visit = parse_visit(page, visit_raw);
			if (!visit) return new Response(null, { status: 400 });
			let list = this.#visits.get(visit.page);
			if (!list) {
				if (this.#visits.size >= MAX_VITALS_PATHS) this.#visits.delete(this.#visits.keys().next().value!);
				this.#visits.set(visit.page, (list = []));
			}
			// the same visit again (its other half, or its final post): fold, don't append
			const same = list.findIndex((v) => v.at === visit.at);
			if (same !== -1) list[same] = merge_visits(list[same], visit);
			else {
				list.push(visit);
				if (list.length > MAX_VISITS_PER_PAGE) list.shift();
			}
		}
		if (cpu && typeof cpu === 'object' && typeof page === 'string' && page.startsWith('/') && page.length <= 500 && this.#client_cpu) {
			if (!(await this.#ingest_client_cpu(page, cpu, ctx.url.origin))) return new Response(null, { status: 400 });
		}
		const now = Date.now();
		// THE APP'S MARKS (`mark()` from ogygia/profiler/client): per page, per name, bounded
		if (Array.isArray(marks) && typeof page === 'string' && page.startsWith('/') && page.length <= 500) {
			let by_name = this.#marks.get(page);
			if (!by_name) {
				if (this.#marks.size >= MAX_VITALS_PATHS) this.#marks.delete(this.#marks.keys().next().value!);
				this.#marks.set(page, (by_name = new Map()));
			}
			for (const m of marks.slice(0, MAX_BEACON_ISLANDS)) {
				const name = typeof m?.name === 'string' ? m.name.slice(0, 120) : '';
				const ms = Number(m?.ms);
				if (!name || !Number.isFinite(ms) || ms < 0 || ms > 600_000) continue;
				let agg = by_name.get(name);
				if (!agg) {
					if (by_name.size >= 100) continue;
					by_name.set(name, (agg = { ms: [], errors: 0, attr_keys: new Set() }));
				}
				agg.ms.push(round2(ms));
				if (agg.ms.length > MAX_BEACON_SAMPLES) agg.ms.shift();
				const attrs = m?.attrs && typeof m.attrs === 'object' ? (m.attrs as Record<string, unknown>) : null;
				if (attrs?.error === true) agg.errors++;
				for (const k of Object.keys(attrs ?? {}).slice(0, 12)) if (k !== 'error') agg.attr_keys.add(k.slice(0, 40));
			}
		}
		// WEB VITALS for the page: what this visit's browser measured, kept per path
		if (vitals && typeof vitals === 'object' && typeof page === 'string' && page.startsWith('/') && page.length <= 500) {
			const v = vitals as Record<string, unknown>;
			const num = (k: string, max: number) => {
				const n = Number(v[k]);
				return Number.isFinite(n) && n >= 0 && n <= max ? round2(n) : undefined;
			};
			const sample: VitalsSample = {};
			const ttfb = num('ttfb', 600_000);
			const fcp = num('fcp', 600_000);
			const lcp = num('lcp', 600_000);
			const cls = num('cls', 100);
			const inp = num('inp', 600_000);
			if (ttfb !== undefined) sample.ttfb = ttfb;
			if (fcp !== undefined) sample.fcp = fcp;
			if (lcp !== undefined) sample.lcp = lcp;
			if (cls !== undefined) sample.cls = cls;
			if (inp !== undefined) sample.inp = inp;
			if (Object.keys(sample).length) {
				let e = this.#vitals.get(page);
				if (!e) {
					if (this.#vitals.size >= MAX_VITALS_PATHS) {
						let oldest: string | undefined;
						let t = Infinity;
						for (const [k, x] of this.#vitals) if (x.last < t) (t = x.last), (oldest = k);
						if (oldest !== undefined) this.#vitals.delete(oldest);
					}
					this.#vitals.set(page, (e = { samples: [], last: now }));
				}
				e.last = now;
				e.samples.push(sample);
				if (e.samples.length > MAX_VITALS_SAMPLES) e.samples.shift();
			}
		}
		for (const it of Array.isArray(islands) ? islands.slice(0, MAX_BEACON_ISLANDS) : []) {
			const fp = typeof it?.fp === 'string' ? it.fp : '';
			const ms = Number(it?.ms);
			const load = Number(it?.load);
			if (!is_hex_id(fp) || !Number.isFinite(ms) || ms < 0 || ms > 600_000) continue;
			let agg = this.#beacons.get(fp);
			if (!agg) {
				if (this.#beacons.size >= MAX_BEACON_FPS) {
					// drop the stalest fingerprint
					let oldest: string | undefined;
					let t = Infinity;
					for (const [k, v] of this.#beacons) if (v.last < t) (t = v.last), (oldest = k);
					if (oldest !== undefined) this.#beacons.delete(oldest);
				}
				this.#beacons.set(fp, (agg = { entry: typeof it?.entry === 'string' ? it.entry.slice(0, 300) : '', ms: [], load: [], recovered: 0, last: now }));
			}
			agg.last = now;
			if (it?.recovered === true) agg.recovered++;
			if (typeof it?.reason === 'string' && it.reason) agg.reason = it.reason.slice(0, 300);
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
		// the query, for a replay — Kit THROWS on `url.search` while prerendering, so read it guarded
		try {
			if (event.url.search) entry.search = event.url.search;
		} catch {
			/* prerendering: no query to keep */
		}
		// the inputs a caught request is replayed with: only the headers the trap config names
		if (this.#trap?.replay?.length) {
			const kept: Record<string, string> = {};
			for (const h of this.#trap.replay) {
				const v = event.request.headers.get(h);
				if (v !== null) kept[h.toLowerCase()] = v.slice(0, 2048);
			}
			if (Object.keys(kept).length) entry.replay_headers = kept;
		}

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
		// (a background window — the trap, the sampler — never opens a per-request context: the
		// request is matched to the window by time instead, so the site pays the sampler only)
		const attribute =
			!!this.#als && (this.dev || (this.#recording_active() && !this.#trap_running) || header_profile);
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
		entry.pt = start; // the perf clock: what a trap window matches the request's timeline on
		const cpu0 = process.cpuUsage();
		this.#inflight++;

		// Kit's `event.fetch` answers a same-origin call in-process, past the global fetch patch: a
		// load calling its own API is a wait the profiler would not see. Wrap it while attributing
		// (one closure per attributed request; nothing on an idle request).
		if (ctx && this.#wrap_event_fetch && typeof event.fetch === 'function') {
			try {
				event.fetch = this.#wrap_event_fetch(event.fetch);
			} catch {
				// a frozen event (a test double) — the global patch still covers real HTTP
			}
		}
		const beacon_tag = await this.#beacon_tag(event);
		const resolve_page = () =>
			beacon_tag
				? resolve(event, {
						transformPageChunk: ({ html }) => {
							// no regex per chunk: the head's close by search (lowercase first, the rare uppercase after)
							let at = html.indexOf('</head>');
							if (at === -1) at = html.indexOf('</HEAD>');
							return at === -1 ? html : html.slice(0, at) + beacon_tag + html.slice(at);
						}
					})
				: resolve(event);
		const run = async (): Promise<Response> => {
			const res =
				ctx && this.#als ? await this.#als.run(ctx, resolve_page) : await resolve_page();
			entry.status = res.status;
			// the profiler's own user gets the JS Self-Profiling policy: the runtime can then sample the
			// main thread while the page hydrates and beacon the trace (never a visitor: no tag, no policy)
			if (beacon_tag && this.#client_cpu) {
				try {
					res.headers.set('document-policy', 'js-profiling');
				} catch {
					// immutable headers
				}
			}
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
					// NESTED TRACE: a profiler upstream of us is recording and asked — answer with our
					// picture of this request (same exposure policy as Server-Timing)
					if (event.request.headers.get(TRACE_HEADER)) {
						const c = process.cpuUsage(cpu0);
						const net = ctx?.net ?? [];
						res.headers.set(
							TRACE_HEADER,
							encode_trace({
								ms: round2(ms),
								cpu_ms: round2((c.user + c.system) / 1000),
								wait_ms: round2(net.reduce((a, x) => a + Math.max(x.ms, 0) + (x.body_ms ?? 0), 0)),
								calls: net.length,
								route: event.route?.id ?? null,
								top: [...net].sort((x, y) => y.ms - x.ms).slice(0, 5).map((x) => ({ url: x.url.slice(0, 200), ms: round2(x.ms + (x.body_ms ?? 0)) })),
								profiler: this.base
							})
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
				// the inputs a replay renders with: the path + query, and the headers the trap config keeps
				const stored = this.#reports.get(id);
				if (stored) stored.replay = { path: entry.path + (entry.search ?? ''), headers: entry.replay_headers ?? {} };
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
		if (this.#sink_url && !entry.internal) {
			this.#sink.push({ k: 'req', t: entry.ts, path: entry.path, route: entry.route, ms: entry.ms, cpu: entry.cpu_ms, wait: entry.net_ms, status: entry.status, ...(entry.og ? { og: entry.og.seed_bytes + entry.og.tail_bytes } : {}) });
			// serverless: this instance may be frozen after the response — post now, best effort
			if (Number.isFinite(serverless_work_budget_ms())) void this.#sink_flush();
		}
	}

	// ── the sink ─────────────────────────────────────────────────────────────────────────────
	/** Post the buffered rows as NDJSON to the sink. One post in flight at a time; a failure keeps
	 *  the rows for the next try (the buffer drops its oldest request rows when full). */
	async #sink_flush(): Promise<void> {
		if (!this.#sink_url || this.#sink_inflight || !this.#sink.size) return;
		this.#sink_inflight = true;
		const rows = this.#sink.size;
		const body = this.#sink.drain();
		try {
			const res = await fetch(this.#sink_url, {
				method: 'POST',
				body,
				headers: {
					'content-type': 'application/x-ndjson',
					'x-og-profiler-internal': '1',
					...(this.#sink_key ? { authorization: `Bearer ${this.#sink_key}` } : {})
				},
				signal: AbortSignal.timeout(5000)
			});
			this.#sink_last = { at: Date.now(), ok: res.ok, rows, ...(res.ok ? {} : { error: `the sink answered ${res.status}` }) };
			if (!res.ok) for (const line of body.split('\n')) if (line) this.#sink.push(JSON.parse(line) as SinkRow);
		} catch (e) {
			this.#sink_last = { at: Date.now(), ok: false, rows, error: e instanceof Error ? e.message : String(e) };
			for (const line of body.split('\n')) if (line) this.#sink.push(JSON.parse(line) as SinkRow);
		} finally {
			this.#sink_inflight = false;
		}
	}

	/** The site view's rows from THIS instance: the request ring and the sampler's windows — what a
	 *  long-lived host has without a sink. */
	#site_rows(): SinkRow[] {
		const rows: SinkRow[] = [];
		for (const e of this.#ring) if (!e.internal) rows.push({ k: 'req', t: e.ts, path: e.path, route: e.route, ms: e.ms, cpu: e.cpu_ms, wait: e.net_ms, status: e.status, ...(e.og ? { og: e.og.seed_bytes + e.og.tail_bytes } : {}) });
		for (const w of this.#sampled) rows.push({ k: 'win', t0: w.at, t1: w.at + w.ms, fns: w.functions.slice(0, 40).map((f) => ({ name: f.name, file: f.url, self_ms: f.self_ms, category: f.category })) });
		for (const r of this.#reports.values()) if (r.meta.trigger === 'trap' && r.meta.request) rows.push({ k: 'trap', t: r.meta.created, path: r.meta.request.path, ms: r.meta.request.ms, id: r.meta.id });
		return rows;
	}

	/** `/site`: the whole-site pictures (the request cloud, the layer cake) from this instance's
	 *  rows, or from a sink the browser reads (`?from=<url>`, or the configured sink). */
	#site(ctx: RouteCtx) {
		const from = ctx.url.searchParams.get('from');
		return {
			base: this.base,
			rows: this.#site_rows(),
			sink: this.#sink_url ? { url: this.#sink_url, last: this.#sink_last, buffered: this.#sink.size } : null,
			from: from && /^https?:\/\//.test(from) ? from.slice(0, 2000) : null,
			ephemeral: Number.isFinite(serverless_work_budget_ms())
		};
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
