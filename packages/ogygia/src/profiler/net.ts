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
	bytes?: number;
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

/**
 * Install the patches. `fallback` receives calls made outside any request
 * context (startup work, background jobs) so window recordings still see them.
 */
export async function install_net_capture(
	als: AsyncLocalStorage<NetContext>,
	fallback: Emit
): Promise<void> {
	if (installed) return;
	installed = true;

	const emit = (call: NetCall) => {
		const ctx = als.getStore();
		if (ctx) {
			call.route = ctx.route;
			call.path = ctx.path;
			ctx.on_net(call);
		} else {
			fallback(call);
		}
	};

	patch_fetch(emit);
	await patch_http(emit);
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
	const orig = globalThis.fetch;
	if (typeof orig !== 'function') return;

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
		emit(call);
		try {
			const res = await orig(input as RequestInfo, init);
			call.ms = round2(performance.now() - call.start);
			call.status = res.status;
			const len = res.headers.get('content-length');
			if (len) call.bytes = Number(len) || undefined;
			wrap_body(res, call);
			return res;
		} catch (e) {
			call.ms = round2(performance.now() - call.start);
			call.error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	};
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
		const rr = res as { statusCode?: number; on?: (ev: string, cb: () => void) => void };
		call.status = rr.statusCode ?? 0;
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
