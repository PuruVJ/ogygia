/**
 * Outbound network capture.
 *
 * Patches `globalThis.fetch` plus `http`/`https` `request`/`get` (covers
 * axios, node-fetch, got, most DB drivers that speak HTTP) and attributes
 * every call to the SvelteKit request that made it via AsyncLocalStorage.
 * Patched once, lazily; originals are kept and called through. When the
 * profiler is disabled this module is never imported.
 */

import type { AsyncLocalStorage } from 'node:async_hooks';

export interface NetCall {
	/** performance.now() at call start */
	start: number;
	/** Date.now() at call start (for window filtering) */
	epoch: number;
	/** ms until headers arrived; -1 while pending */
	ms: number;
	/** additional ms spent reading the body (json()/text()/stream end) */
	body_ms?: number;
	method: string;
	url: string;
	host: string;
	/** 0 = errored before a response */
	status: number;
	/** DECODED response body size (what the app receives) — measured by counting a cloned body stream,
	 *  so it's captured however the app reads (json/text/stream) and even when there's no content-length. */
	bytes?: number;
	/** wire/transfer size from `content-length` (compressed when `encoding` is set) */
	transfer_bytes?: number;
	/** response `content-encoding` (gzip / br / …) when compressed */
	encoding?: string;
	/** short response `content-type` (params stripped) */
	type?: string;
	/** response headers (curated + capped) — shown in the request side panel */
	headers?: Record<string, string>;
	/** request body size in bytes, when it has one */
	req_bytes?: number;
	/** request body preview (truncated) — for string / form / URLSearchParams bodies */
	req_payload?: string;
	kind: 'fetch' | 'http';
	/** route of the page render that made this call, when known */
	route: string | null;
	/** path of the page render that made this call, when known */
	path: string | null;
	/** resolved caller string, filled in at report time from caller_site */
	caller?: string;
	/** raw caller location (bundled), resolved to source at report time */
	caller_site?: CallerSite;
	error?: string;
}

// Capturing a stack on every call has a cost, so only do it while recording.
let capture_stacks = false;
export function set_stack_capture(on: boolean): void {
	capture_stacks = on;
}

// The profiler's own module files, registered at load. Bundlers rename our
// source (net.ts → chunks/net2.js), so a path substring like '/profiler/' won't
// match at runtime. Each profiler module calls register_profiler_file() at load;
// it reads the CALLER's file from a stack trace — same format as the runtime
// stacks we later match against — so those frames get skipped whatever the
// bundler named them.
const profiler_files = new Set<string>();

// Grab the structured call-sites WITHOUT triggering Node's stack-string
// formatter (`defaultPrepareStackTrace`). Reading `new Error().stack` on every
// I/O call formatted the whole stack and showed up as node-core CPU in the
// profile — the profiler measuring itself. This costs a fraction of that.
function call_sites(below: (...a: never[]) => unknown): NodeJS.CallSite[] {
	const orig = Error.prepareStackTrace;
	Error.prepareStackTrace = (_e, sites) => sites;
	const holder: { stack?: unknown } = {};
	Error.captureStackTrace(holder, below);
	// `.stack` is lazy: read it WHILE our override is installed, then restore —
	// otherwise the default (or source-map-support) formatter runs and returns a string
	const sites = holder.stack;
	Error.prepareStackTrace = orig;
	return Array.isArray(sites) ? (sites as NodeJS.CallSite[]) : [];
}

export function register_profiler_file(): void {
	// getFileName() of the caller (the module invoking this) — same format
	// nearest_app_frame later compares against, so the registry always matches.
	const f = call_sites(register_profiler_file)[0]?.getFileName();
	if (f) profiler_files.add(f);
}
register_profiler_file();

/** A caller location as the bundler sees it — resolved to source later, at
 * report time, through the sourcemap resolver (we have no maps here). */
export interface CallerSite {
	fn: string;
	/** generated (bundled) file */
	file: string;
	/** 1-based line in the generated file */
	line: number;
	/** 1-based column in the generated file */
	column: number;
}

/** The nearest first-party frame that issued an I/O call — skips node internals,
 * node_modules, and the profiler's own frames, so the caller reads like your
 * code. Shared by the network patch and the async_hooks I/O tracker. */
export function nearest_app_site(): CallerSite | undefined {
	for (const site of call_sites(nearest_app_site)) {
		const file = site.getFileName();
		if (!file) continue;
		if (
			profiler_files.has(file) ||
			file.includes('/profiler/') ||
			file.startsWith('node:') ||
			/node:internal|[/\\]node_modules[/\\]/.test(file)
		) {
			continue;
		}
		return {
			fn: site.getFunctionName() || '(anonymous)',
			file,
			line: site.getLineNumber() ?? 0,
			column: site.getColumnNumber() ?? 0
		};
	}
	return undefined;
}

/** Best-effort caller string with no sourcemap (fallback before resolution). */
export function nearest_app_frame(): string | undefined {
	const s = nearest_app_site();
	if (!s) return undefined;
	const base = s.file.replace(/^.*[/\\]/, '').replace(/\?.*$/, '');
	return `${s.fn} (${base}:${s.line})`;
}

export interface NetContext {
	route: string | null;
	path: string | null;
	on_net(call: NetCall): void;
}

type Emit = (call: NetCall) => void;

let installed = false;
// The active emit sink, kept module-level so `ensure_fetch_patched` can RE-wrap `globalThis.fetch` with
// the same sink after something replaces it.
let net_emit: Emit | null = null;
// Brands OUR wrapper so a re-assert never wraps our own wrapper (which would count every call twice).
const OG_FETCH_PATCH = Symbol.for('ogygia.profiler.net.fetch-patch');

/**
 * Install the patches. `fallback` receives calls made outside any request
 * context (startup work, background jobs) so window recordings still see them.
 * Idempotent: a second call just re-asserts the fetch patch (see `ensure_fetch_patched`).
 */
export async function install_net_capture(
	als: AsyncLocalStorage<NetContext>,
	fallback: Emit
): Promise<void> {
	net_emit = (call: NetCall) => {
		const ctx = als.getStore();
		if (ctx) {
			call.route = ctx.route;
			call.path = ctx.path;
			ctx.on_net(call);
		} else {
			fallback(call);
		}
	};

	if (installed) {
		ensure_fetch_patched();
		return;
	}
	installed = true;
	patch_fetch(net_emit);
	await patch_http(net_emit);
}

/**
 * Re-assert the `globalThis.fetch` patch. `globalThis.fetch` can be REPLACED out from under us after
 * install — a late undici init, a framework fetch polyfill, an HMR reload of this module — which
 * silently kills capture, so reports "sometimes catch network, sometimes don't". Call this before every
 * profile: if the live fetch isn't ours (identified by the brand symbol, so we never wrap our own
 * wrapper) re-wrap whatever is there now with the same sink. One property read, idempotent — safe to
 * call every request/run.
 */
export function ensure_fetch_patched(): void {
	if (!net_emit) return;
	const cur = globalThis.fetch as (typeof globalThis.fetch & { [OG_FETCH_PATCH]?: boolean }) | undefined;
	if (typeof cur === 'function' && cur[OG_FETCH_PATCH]) return; // still ours
	patch_fetch(net_emit);
}

// ---------------------------------------------------------------------------

const INTERNAL_HEADER = 'x-og-profiler-internal';

function is_internal(input: RequestInfo | URL, init?: RequestInit): boolean {
	if (input instanceof Request && input.headers.has(INTERNAL_HEADER)) return true;
	const h = init?.headers;
	if (!h) return false;
	if (h instanceof Headers) return h.has(INTERNAL_HEADER);
	if (Array.isArray(h)) return h.some(([k]) => k.toLowerCase() === INTERNAL_HEADER);
	return Object.keys(h).some((k) => k.toLowerCase() === INTERNAL_HEADER);
}

function host_of(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
}

function patch_fetch(emit: Emit): void {
	const orig = globalThis.fetch as (typeof globalThis.fetch & { [OG_FETCH_PATCH]?: boolean }) | undefined;
	if (typeof orig !== 'function') return;
	if (orig[OG_FETCH_PATCH]) return; // the live fetch is already our wrapper — don't wrap it again

	const patched = async function fetch(
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> {
		// the profiler's own page-mode self-requests are not the app's traffic
		if (is_internal(input, init)) return orig(input as RequestInfo, init);
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: ((input as Request)?.url ?? '');
		const method = init?.method ?? ((input as Request)?.method || 'GET');
		const call: NetCall = {
			start: performance.now(),
			epoch: Date.now(),
			ms: -1,
			method: method.toUpperCase(),
			url,
			host: host_of(url),
			status: 0,
			kind: 'fetch',
			route: null,
			path: null,
			caller_site: capture_stacks ? nearest_app_site() : undefined
		};
		capture_req_payload(init, call);
		emit(call);
		try {
			const res = await orig(input as RequestInfo, init);
			call.ms = round2(performance.now() - call.start);
			call.status = res.status;
			call.type = short_ct(res.headers.get('content-type'));
			call.encoding = res.headers.get('content-encoding') || undefined;
			const len = res.headers.get('content-length');
			if (len) call.transfer_bytes = Number(len) || undefined;
			call.headers = headers_of(res.headers);
			// Robust DECODED size: count a cloned body stream. Works however the app reads the original
			// (json/text/stream) and with no content-length (chunked / dev servers) — no more dashes.
			count_decoded(res, call);
			wrap_body(res, call);
			return res;
		} catch (e) {
			call.ms = round2(performance.now() - call.start);
			call.error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	};
	(patched as typeof patched & { [OG_FETCH_PATCH]?: boolean })[OG_FETCH_PATCH] = true;
	globalThis.fetch = patched as typeof globalThis.fetch;
}

/** time json()/text()/arrayBuffer() so "slow API" vs "slow body download" is visible */
function wrap_body(res: Response, call: NetCall): void {
	for (const name of ['json', 'text', 'arrayBuffer'] as const) {
		const orig = res[name]?.bind(res);
		if (!orig) continue;
		try {
			Object.defineProperty(res, name, {
				configurable: true,
				writable: true,
				value: async function () {
					const t = performance.now();
					const v = await orig();
					call.body_ms = round2((call.body_ms ?? 0) + (performance.now() - t));
					if (call.bytes === undefined) {
						if (typeof v === 'string') call.bytes = v.length;
						else if (v instanceof ArrayBuffer) call.bytes = v.byteLength;
					}
					return v;
				}
			});
		} catch {
			// frozen response — skip body timing
		}
	}
}

/** Strip params from a content-type: "application/json; charset=utf-8" → "application/json". */
function short_ct(ct: string | null): string | undefined {
	if (!ct) return undefined;
	const i = ct.indexOf(';');
	return (i === -1 ? ct : ct.slice(0, i)).trim() || undefined;
}

/** Snapshot response headers for the request side panel. Capped (≤40 entries, ≤512 chars each) so a
 *  rogue header value can't bloat the `.ogp`. Returns undefined when there are none. */
function headers_of(h: Headers): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	let n = 0;
	for (const [k, v] of h) {
		if (n++ >= 40) break;
		out[k] = v.length > 512 ? v.slice(0, 512) + '…' : v;
	}
	return n ? out : undefined;
}

// Keep request bodies large enough to inspect the real thing — workplaces routinely POST multi-MB JSON.
// The report/window path holds the full clipped body; the report UI formats + highlights it lazily and
// off the main thread (see Shell.svelte) so a big payload never freezes the page. 4 MB is the ceiling a
// single body is stored at; a page's handful of outbound calls keeps peak memory bounded.
const MAX_PAYLOAD = 4_000_000;
const utf8_len = (s: string): number => {
	try {
		return new TextEncoder().encode(s).byteLength;
	} catch {
		return s.length;
	}
};
const clip = (s: string): string => (s.length > MAX_PAYLOAD ? s.slice(0, MAX_PAYLOAD) + '\n… (truncated)' : s);

/** Capture the request body's size (+ a preview for string / form bodies). Never consumes a stream. */
function capture_req_payload(init: RequestInit | undefined, call: NetCall): void {
	const body = init?.body;
	if (body == null) return;
	try {
		if (typeof body === 'string') {
			call.req_bytes = utf8_len(body);
			call.req_payload = clip(body);
		} else if (body instanceof URLSearchParams) {
			const s = body.toString();
			call.req_bytes = utf8_len(s);
			call.req_payload = clip(s);
		} else if (body instanceof ArrayBuffer) {
			call.req_bytes = body.byteLength;
		} else if (ArrayBuffer.isView(body)) {
			call.req_bytes = (body as ArrayBufferView).byteLength;
		}
		// FormData / Blob / ReadableStream: sizing would consume/serialize it — skip.
	} catch {
		/* exotic body — skip */
	}
}

/** Count the DECODED response body size by draining a CLONE in the background (the original is left
 *  untouched). Sets `call.bytes` when done — the render finishes first, so it's ready by report time. */
function count_decoded(res: Response, call: NetCall): void {
	let clone: Response;
	try {
		clone = res.clone();
	} catch {
		return; // already consumed, or not cloneable
	}
	const stream = clone.body;
	if (!stream) return;
	void (async () => {
		try {
			const reader = stream.getReader();
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value?.byteLength ?? 0;
			}
			call.bytes = total;
		} catch {
			/* stream errored mid-read — leave the size to the wrap_body / transfer fallback */
		}
	})();
}

// ---------------------------------------------------------------------------

async function patch_http(emit: Emit): Promise<void> {
	for (const proto of ['http', 'https'] as const) {
		let mod: Record<string, unknown>;
		try {
			mod = (await import(/* @vite-ignore */ `node:${proto}`)).default as Record<string, unknown>;
		} catch {
			continue;
		}
		const orig_request = mod.request as (...args: unknown[]) => unknown;
		const orig_get = mod.get as (...args: unknown[]) => unknown;
		if (typeof orig_request !== 'function') continue;
		try {
			mod.request = function (...args: unknown[]) {
				const req = orig_request.apply(this, args);
				instrument_client_request(req, args, proto, emit);
				return req;
			};
			if (typeof orig_get === 'function') {
				mod.get = function (...args: unknown[]) {
					const req = orig_get.apply(this, args);
					instrument_client_request(req, args, proto, emit);
					return req;
				};
			}
		} catch {
			// module object not writable on this platform — fetch patch still works
		}
	}
}

function instrument_client_request(
	req: unknown,
	args: unknown[],
	proto: 'http' | 'https',
	emit: Emit
): void {
	const r = req as {
		on?: (ev: string, cb: (arg?: unknown) => void) => void;
		method?: string;
	};
	if (typeof r?.on !== 'function') return;

	// args: (url[, options][, cb]) or (options[, cb])
	let url = '';
	let method = 'GET';
	const a0 = args[0];
	if (typeof a0 === 'string') url = a0;
	else if (a0 instanceof URL) url = a0.href;
	const opts = (typeof a0 === 'object' && !(a0 instanceof URL) ? a0 : args[1]) as
		| Record<string, unknown>
		| undefined;
	if (opts && typeof opts === 'object') {
		if (typeof opts.method === 'string') method = opts.method;
		if (!url) {
			const host = (opts.hostname as string) || (opts.host as string) || 'localhost';
			const port = opts.port ? `:${opts.port}` : '';
			const path = (opts.path as string) || '/';
			url = `${proto}://${host}${port}${path}`;
		}
	}
	if (r.method) method = r.method;

	const call: NetCall = {
		start: performance.now(),
		epoch: Date.now(),
		ms: -1,
		method: method.toUpperCase(),
		url,
		host: host_of(url),
		status: 0,
		kind: 'http',
		route: null,
		path: null,
		caller_site: capture_stacks ? nearest_app_site() : undefined
	};
	emit(call);

	r.on('response', (res) => {
		call.ms = round2(performance.now() - call.start);
		const rr = res as {
			statusCode?: number;
			headers?: Record<string, string | string[] | undefined>;
			on?: (ev: string, cb: () => void) => void;
		};
		call.status = rr.statusCode ?? 0;
		const h = rr.headers ?? {};
		const str_h = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
		const len = str_h(h['content-length']);
		if (len) call.transfer_bytes = Number(len) || undefined;
		call.encoding = str_h(h['content-encoding']) || undefined;
		call.type = short_ct(str_h(h['content-type']) ?? null);
		// no cloned-stream count here: adding a 'data' listener would flip a paused stream to flowing and
		// could steal chunks from the app — content-length is the safe size on the raw-http path.
		rr.on?.('end', () => {
			call.body_ms = round2(performance.now() - call.start - call.ms);
		});
	});
	r.on('error', (e) => {
		if (call.ms === -1) call.ms = round2(performance.now() - call.start);
		call.error = e instanceof Error ? e.message : String(e);
	});
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * How much of the wall time is explained by network calls running one after
 * another (no overlap). High sequential time with several calls = the classic
 * "await in a loop" page.
 */
export function sequential_ms(calls: NetCall[]): number {
	const done = calls
		.filter((c) => c.ms >= 0)
		.map((c) => ({ s: c.start, e: c.start + c.ms + (c.body_ms ?? 0) }))
		.sort((a, b) => a.s - b.s);
	let total = 0;
	let edge = -Infinity;
	for (const c of done) {
		if (c.s >= edge) total += c.e - c.s;
		else if (c.e > edge) total += c.e - edge;
		edge = Math.max(edge, c.e);
	}
	return Math.round(total * 100) / 100;
}
