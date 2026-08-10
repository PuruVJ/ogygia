/**
 * SvelteKit server `handle` for signed region holes (`defer` / remount:`swr`).
 *
 * Serves `GET <base>/🏝️?id=…&props=…&exp=…&sig=…` by verifying the region MAC,
 * rendering the region component server-side (cookies, remote functions, and `await` work),
 * and returning HTML for the client runtime to swap in.
 *
 * Composable with `sequence()` — intercepts only the region endpoint path; otherwise
 * calls `resolve(event)`. Also injects the document-level page seed used by islands.
 *
 * @example
 * ```ts
 * // src/hooks.server.ts
 * import { ogygiaHandle } from 'ogygia/hooks';
 * import { sequence } from '@sveltejs/kit/hooks';
 * export const handle = sequence(ogygiaHandle(), myOtherHandle);
 * ```
 *
 * @packageDocumentation
 */
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { try_get_request_store } from '@sveltejs/kit/internal/server';
import type { RequestState } from '@sveltejs/kit/internal/server';
import * as devalue from 'devalue';
// Route MATCHING needs the ABSOLUTE base-prefixed path to compare against `event.url.pathname`.
// `resolve()` is deliberately RELATIVE on the server (for browser-resolved link generation), so
// it's the wrong tool here — server-side pathname matching uses `base`.
import { base } from '$app/paths';
import { building } from '$app/environment';
import { islands as island_modules } from 'virtual:ogygia/server-manifest';
import { secret } from 'virtual:ogygia/secret';
import { rateLimit as rate_limit_cfg } from 'virtual:ogygia/rate-limit';
import { sessionCookie as session_cookie } from 'virtual:ogygia/session-cookie';
import { stream as stream_enabled } from 'virtual:ogygia/stream';
import { policies as shell_policies } from 'virtual:ogygia/shell';
import { verify, region_mac_message } from './server/hmac.js';
import { B64Url } from './server/payload.js';
import { TRANSPORT_WIRE_KEY, revive_transportable } from './live-transport.js';
import { DEFAULT_ISLANDS_ENDPOINT, MAX_REGION_PROPS_LEN, REGION_ID_RE } from './server/endpoint.js';
import {
	build_parcel,
	done_parcel,
	find_streamable_regions
} from './server/stream-regions.js';
import { html_has_kit_bootstrap } from './runtime/kit-boot.js';
import { RateLimiter } from './server/rate-limit.js';
import { PageSeed } from './server/page-seed.js';
import { ConcurrencyGate, REGION_RENDER_CONCURRENCY } from './runtime/concurrency.js';

/** Hard cap on rendered region HTML (bytes). */
const MAX_REGION_BODY = 2_000_000;
/** Per-route shell-cache policy (from `virtual:ogygia/shell`). */
type ShellPolicy = { mode: 'cache' | 'swr'; maxAgeMs?: number };
/** The `resolve` passed to a Kit handle (subset used for background shell revalidation). */
type ResolveFn = (
	event: RequestEvent,
	opts?: {
		transformPageChunk?: (i: {
			html: string;
			done: boolean;
		}) => string | undefined | Promise<string | undefined>;
	}
) => Response | Promise<Response>;
interface ShellEntry {
	html: string;
	/** capture time (ms) — used for `ttl` staleness. */
	at: number;
}
/**
 * Shell cache: pathname → captured static shell. Process-lifetime, LRU-bounded. Replaying an
 * entry skips the per-request render; `defer` holes still stream fresh into it.
 */
const shell_cache = new Map<string, ShellEntry>();
/** LRU cap on the shell cache; oldest entry is evicted when exceeded. */
const SHELL_CACHE_MAX = 1024;
/** Move an entry to the end of the Map (most-recently-used). */
function shell_cache_touch(pathname: string) {
	const e = shell_cache.get(pathname);
	if (e) { shell_cache.delete(pathname); shell_cache.set(pathname, e); }
}
function shell_entry_stale(entry: ShellEntry, policy: ShellPolicy): boolean {
	return policy.maxAgeMs != null && Date.now() - entry.at >= policy.maxAgeMs;
}
/** Abort waiting on slow region SSR (work may continue — see INVARIANTS · RENDER-TIMEOUT). */
const RENDER_TIMEOUT_MS = 10_000;

/** Process-local cap on concurrent region SSR (M1 CPU amp under valid MAC). */
const render_gate = new ConcurrencyGate(REGION_RENDER_CONCURRENCY);

/**
 * Anti-framing + MIME + Referrer on every region response.
 * Referrer-Policy strips capability query strings from third-party asset requests (H6).
 */
const REGION_FRAME_HEADERS = {
	'X-Frame-Options': 'DENY',
	'Content-Security-Policy': "frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer'
} as const;

function region_response(body: BodyInit | null, init: { status: number; headers?: Record<string, string> }) {
	return new Response(body, {
		status: init.status,
		headers: { ...REGION_FRAME_HEADERS, ...init.headers }
	});
}

/**
 * Decode a request pathname without throwing on malformed percent-encoding (SEC-05).
 * @returns {string | null} decoded path, or null if the encoding is invalid
 */
function decode_pathname(pathname: string): string | null {
	try {
		return decodeURIComponent(pathname);
	} catch {
		return null;
	}
}

/** Resolve a rate-limit key; fail closed (null) when the adapter cannot identify the client.
 * Never trust X-Forwarded-For / spoofable proxy headers — adapters must provide getClientAddress(). */
function client_ip(event: RequestEvent): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}

class OgygiaHandle {
	readonly #endpoint: string;
	readonly render_rate: RateLimiter;
	readonly probe_rate: RateLimiter;

	constructor(options: OgygiaHandleOptions = {}) {
		this.#endpoint = (base || '') + (options.endpoint || DEFAULT_ISLANDS_ENDPOINT);
		this.render_rate = new RateLimiter({
			max: rate_limit_cfg.max,
			windowMs: rate_limit_cfg.windowMs
		});
		/** Cheap pre-HMAC probe budget — forged traffic pays this, not full render quota (HMAC-CPU-DOS). */
		this.probe_rate = new RateLimiter({
			max: rate_limit_cfg.max <= 0 ? 0 : Math.max(rate_limit_cfg.max * 5, 120),
			windowMs: rate_limit_cfg.windowMs
		});
	}

	handle: Handle = async ({ event, resolve }) => {
		const path = decode_pathname(event.url.pathname);
		if (path === null) {
			return new Response('Bad Request', { status: 400 });
		}
		// Compare against the DECODED request pathname so the percent-encoded UTF-8 the browser
		// sends matches our raw-emoji literal regardless of how Kit hands us the URL.
		if (path !== this.#endpoint) {
			// Flicker fix: on csr=false pages Kit resolves top-level `await query()` calls during
			// SSR (populating the internal request store's `remote.implicit`) but only serializes
			// them into the page when csr===true. We capture the resolved query responses and emit
			// a `<script type="application/ogygia-remote">` side-channel the runtime reads to seed
			// the reused client query cache BEFORE islands hydrate — so no re-fetch, no flash. The
			// store is captured synchronously here (active inside Kit's `with_request_store`); it is
			// the SAME object reference Kit mutates during the render inside `resolve`.
			const store = try_get_request_store();
			const shell_policy = this.#shell_policy(event);
			// Shell caching implies streaming: the replayed shell needs the stream meta + parcels.
			const streaming = this.#should_stream(event) || shell_policy != null;
			// A Kit-bootstrapped (csr=true) page serializes its own remotes and hydrates the whole
			// tree — we skip seeds there, and must not stream (the runtime won't read parcels without
			// the meta). `inject_client_seeds` flips this once it sees the bootstrap in any chunk; the
			// wrapper checks it only after the full body is read, so the decision is final.
			const stream_token = { skip: false };

			// Replay a cached shell: skip resolve() entirely (instant TTFB), stream holes fresh. A
			// `swr` route also kicks off a background revalidation; a `cache` route with a stale ttl
			// falls through to a fresh render.
			if (shell_policy) {
				const entry = shell_cache.get(event.url.pathname);
				if (entry && !(shell_policy.mode === 'cache' && shell_entry_stale(entry, shell_policy))) {
					shell_cache_touch(event.url.pathname);
					if (shell_policy.mode === 'swr' && (shell_policy.maxAgeMs == null || shell_entry_stale(entry, shell_policy))) {
						void this.#revalidate_shell(event, resolve);
					}
					const shell_res = new Response(entry.html, {
						headers: { 'content-type': 'text/html; charset=utf-8' }
					});
					return this.#stream_regions(shell_res, event, stream_token);
				}
			}

			const res = await resolve(event, {
				transformPageChunk: async ({ html }) =>
					this.inject_client_seeds(html, store?.state, event, streaming, stream_token)
			});

			// Capture the shell for later replay — only when it is genuinely static (no Kit bootstrap,
			// no per-request remote data). A dynamic shell silently falls back to per-request render.
			if (shell_policy) {
				const shell_text = await res.text();
				if (!stream_token.skip) this.#store_shell(event.url.pathname, shell_text, store?.state);
				const shell_res = new Response(shell_text, {
					status: res.status,
					headers: res.headers
				});
				return this.#stream_regions(shell_res, event, stream_token);
			}

			return streaming ? this.#stream_regions(res, event, stream_token) : res;
		}
		return await this.render_region(event);
	};

	/**
	 * Stream `defer: 'load'` holes down THIS response only on a real, dynamic page request. Never
	 * while prerendering (no live connection — those holes keep client-fetch), never for a
	 * sub-request, only for GET. Off entirely unless `ogygia({ stream: true })`.
	 */
	#should_stream(event: RequestEvent): boolean {
		if (!stream_enabled || building) return false;
		if (event.request.method.toUpperCase() !== 'GET') return false;
		if (event.isSubRequest) return false;
		return true;
	}

	/**
	 * The shell policy for this request, or null. Eligible on a real, dynamic GET with no query
	 * string (the cache is keyed by pathname; a query-varying shell would serve stale bytes)
	 * whose ROUTE opted in (`export const shell` on the page/layout, or the global default).
	 */
	#shell_policy(event: RequestEvent): ShellPolicy | null {
		if (building) return null;
		if (event.request.method.toUpperCase() !== 'GET') return null;
		if (event.isSubRequest) return null;
		if (event.url.search) return null;
		const id = event.route?.id;
		return id != null ? (shell_policies[id] ?? null) : null;
	}

	/**
	 * Store a captured shell — only when it is genuinely static: no Kit bootstrap (csr=true) and
	 * no per-request remote data. LRU-evicts the oldest entry past the cap.
	 */
	#store_shell(pathname: string, html: string, state: RequestState | undefined) {
		const implicit = state?.remote?.implicit;
		if (html_has_kit_bootstrap(html) || (implicit && implicit.size > 0)) return;
		if (shell_cache.size >= SHELL_CACHE_MAX && !shell_cache.has(pathname)) {
			const oldest = shell_cache.keys().next().value;
			if (oldest !== undefined) shell_cache.delete(oldest);
		}
		shell_cache.delete(pathname);
		shell_cache.set(pathname, { html, at: Date.now() });
	}

	/**
	 * Background `swr` revalidation: re-render the shell out of band and refresh the cache for
	 * the next request. Fire-and-forget — never rejects into the served (stale) response.
	 */
	async #revalidate_shell(event: RequestEvent, resolve: ResolveFn): Promise<void> {
		try {
			const token = { skip: false };
			const store = try_get_request_store();
			const res = await resolve(event, {
				transformPageChunk: async ({ html }: { html: string }) =>
					this.inject_client_seeds(html, store?.state, event, true, token)
			});
			const text = await res.text();
			if (!token.skip) this.#store_shell(event.url.pathname, text, store?.state);
		} catch {
			/* stale entry stays; revalidation is best-effort */
		}
	}

	/**
	 * Document-level side-channels: one page snapshot + optional remote query seed.
	 * Skips Kit-booted (csr=true) pages which serialize remotes themselves.
	 */
	async inject_client_seeds(
		html: string,
		state: RequestState | undefined,
		event?: RequestEvent,
		streaming = false,
		stream_token?: { skip: boolean }
	): Promise<string> {
		if (html_has_kit_bootstrap(html)) {
			// csr=true page — do not stream (no meta injected → runtime cannot consume parcels).
			if (stream_token) stream_token.skip = true;
			return html;
		}

		const scripts: string[] = [];

		// Tell the runtime this page streams its holes, so a `defer: 'load'` region waits for its
		// parcel (or the done-sentinel) before falling back to a fetch. Absent → fetch immediately.
		if (streaming) {
			scripts.push('<meta name="ogygia-stream" content="1">');
		}

		// Single page seed (PAGE-DUP) — islands read it through the `$app/state` shim. Sourced from
		// the RequestEvent, NOT `$app/state`'s `page`: that is a rune (component-scoped) and throws
		// `lifecycle_outside_component` when read inside a handle hook, so the whole seed was null
		// and islands only saw the client `location` fallback for `url` (params/route/status empty).
		// PAGE-SEED-EVENT.
		const page_payload = event
			? PageSeed.serialize({
					url: event.url,
					params: event.params,
					route: event.route,
					status: 200
				})
			: null;
		if (page_payload) {
			scripts.push(`<script type="application/ogygia-page" data-ogygia-page>${page_payload}</script>`);
		}

		if (state?.remote?.implicit) {
			const remote_script = await this.build_remote_seed_script(state);
			if (remote_script) scripts.push(remote_script);
		}

		if (scripts.length === 0) return html;
		const block = scripts.join('');
		return html.includes('</body>') ? html.replace('</body>', block + '</body>') : html + block;
	}

	async build_remote_seed_script(state: RequestState): Promise<string | null> {
		const implicit = state.remote?.implicit;
		if (!implicit) return null;

		const q: Record<string, { v: unknown }> = {};
		for (const [internals, record] of implicit) {
			// Private (non-exported) remote functions have no `id` and must never be serialized.
			if (!internals.id || internals.type !== 'query') continue;
			for (const key in record) {
				const remote_key = internals.id + '/' + key;
				const promise = state.remote.data?.get(internals)?.[key] ?? record[key]();
				let resolved = true;
				await Promise.race([
					Promise.resolve(promise).then(
						(v) => {
							if (resolved) q[remote_key] = { v };
						},
						() => {
							/* errored queries are not seeded */
						}
					),
					Promise.resolve().then(() => {
						resolved = false;
					})
				]);
			}
		}

		if (Object.keys(q).length === 0) return null;

		const transport = state.transport || {};
		const reducers = Object.fromEntries(
			Object.entries(transport).map(([name, codec]) => [name, codec.encode])
		);
		const payload = devalue.stringify({ q }, reducers).replaceAll('<', '\\u003C');
		return `<script type="application/ogygia-remote">${payload}</script>`;
	}

	/**
	 * `render()` the island under the concurrency gate + timeout. Returns the HTML body, or `null`
	 * if the render threw or timed out. Shared by the endpoint ({@link render_region}) and the
	 * streaming path ({@link #render_capability}).
	 */
	async #render_component(
		load: () => Promise<{ default: unknown }>,
		props: Record<string, unknown>
	): Promise<string | null> {
		try {
			return await render_gate.run(async () => {
				const mod = await load();
				const rendered = render(mod.default as Component<Record<string, unknown>>, { props });
				return await Promise.race([
					Promise.resolve(rendered).then((out) => out.body as string),
					new Promise<never>((_, rej) =>
						setTimeout(() => rej(new Error('region render timeout')), RENDER_TIMEOUT_MS)
					)
				]);
			});
		} catch {
			return null;
		}
	}

	/**
	 * Streaming: verify a hole's OWN signed capability URL and render it in-process. Same trust
	 * boundary as the endpoint (verify the MAC before touching the manifest), but every failure —
	 * bad/expired MAC, unknown id, non-serializable props, render error, oversize — resolves to
	 * `null` so the hole silently falls back to a client fetch. Never throws.
	 */
	async #render_capability(
		endpoint: string,
		event: RequestEvent
	): Promise<{ slot: string; html: string } | null> {
		const q = endpoint.indexOf('?');
		if (q === -1) return null;
		const params = new URLSearchParams(endpoint.slice(q + 1));
		const id = params.get('id') ?? '';
		const payload = params.get('props') ?? '';
		const exp_raw = params.get('exp') ?? '';
		const sig = params.get('sig') ?? '';

		if (!REGION_ID_RE.test(id) || payload.length > MAX_REGION_PROPS_LEN) return null;
		const exp = Number(exp_raw);
		if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;

		// The capability was minted this same request, sealing the same session cookie (if any).
		const session = session_cookie ? (event.cookies.get(session_cookie) ?? '') : '';
		if (!verify(secret, region_mac_message(id, exp_raw, payload, session), sig)) return null;

		if (!Object.hasOwn(island_modules, id)) return null;
		const load = island_modules[id];
		if (typeof load !== 'function') return null;

		let props: unknown;
		try {
			// Evaluate the island module BEFORE parsing: transportable classes register their
			// codecs at module eval, and the reviver needs them (cold-start defer requests may
			// hit a process where the minting page never rendered).
			await load();
			props = devalue.parse(B64Url.decode(payload), {
				[TRANSPORT_WIRE_KEY]: (d: never) => revive_transportable(d, false)
			});
		} catch {
			return null;
		}
		if (props === null || typeof props !== 'object' || Array.isArray(props)) return null;

		const html = await this.#render_component(load, props as Record<string, unknown>);
		if (html === null || html.length > MAX_REGION_BODY) return null;
		return { slot: sig, html };
	}

	/**
	 * Wrap the resolved page response so the shell streams out immediately, each immediate deferred
	 * hole renders in parallel, and its HTML is appended after the document as a
	 * `<template data-ogygia-slot>` parcel. The parser drops appended templates into `<body>` inert;
	 * the runtime moves each into its region. A final done-sentinel tells still-waiting regions to
	 * fall back to fetch. Non-HTML responses pass through untouched.
	 */
	#stream_regions(res: Response, event: RequestEvent, stream_token: { skip: boolean }): Response {
		const content_type = res.headers.get('content-type') || '';
		if (!res.body || !content_type.includes('text/html')) return res;

		const source = res.body;
		const render_capability = (endpoint: string) => this.#render_capability(endpoint, event);
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const seen = new Set<string>();
				const parked: Array<Promise<string | null>> = [];
				let buffer = '';

				// Discover any newly-complete hole tags in the buffer and start rendering each. Skip
				// once the page proves to be csr=true (Kit-bootstrapped) — parcels would be unused.
				const scan = () => {
					if (stream_token.skip) return;
					for (const region of find_streamable_regions(buffer)) {
						if (seen.has(region.slot)) continue;
						seen.add(region.slot);
						parked.push(
							render_capability(region.endpoint)
								.then((out) => (out ? build_parcel(out.slot, out.html) : null))
								.catch(() => null)
						);
					}
				};

				const reader = source.getReader();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						controller.enqueue(value); // forward the shell chunk NOW — early paint
						buffer += decoder.decode(value, { stream: true });
						scan();
					}
					buffer += decoder.decode();
					scan();
				} catch {
					// Source errored mid-stream — stop scanning; flush whatever parcels resolved.
				}

				// csr=true page (bootstrap seen in a later chunk): append nothing, just end.
				if (stream_token.skip) {
					controller.close();
					return;
				}

				// Append each parcel as its render settles. Out-of-order is fine: the slot id routes it.
				await Promise.all(
					parked.map(async (p) => {
						const parcel = await p;
						if (parcel) controller.enqueue(encoder.encode(parcel));
					})
				);
				controller.enqueue(encoder.encode(done_parcel()));
				controller.close();
			},
			cancel() {
				source.cancel().catch(() => {});
			}
		});

		const headers = new Headers(res.headers);
		// Chunked now — a stale Content-Length would truncate the body. Ask nginx-style proxies not
		// to buffer, so the shell still paints early behind a reverse proxy.
		headers.delete('content-length');
		headers.set('x-accel-buffering', 'no');
		return new Response(stream, { status: res.status, statusText: res.statusText, headers });
	}

	/**
	 * Verify the region MAC, then render. Unknown ids and bad MACs both return 403 so the
	 * existence of a region id is not an oracle (SEC-01). Expiry is part of the MAC message.
	 *
	 * Ordering: length/exp → probe rate (pre-HMAC) → verify → render rate → render.
	 * Probe stops forged CPU amplification; render budget is only charged after a valid MAC.
	 */
	async render_region(event: RequestEvent) {
		const method = event.request.method.toUpperCase();
		if (method !== 'GET' && method !== 'HEAD') {
			return region_response('Method Not Allowed', {
				status: 405,
				headers: { allow: 'GET, HEAD' }
			});
		}

		// Harvested capability URLs embedded cross-site (img/script/navigation) — reject when the
		// browser reports cross-site. Missing Sec-Fetch-Site (old clients) is allowed.
		const fetch_site = event.request.headers.get('sec-fetch-site');
		if (fetch_site === 'cross-site') {
			return region_response('Forbidden', { status: 403 });
		}

		const url = event.url;
		const ip = client_ip(event);
		if (!ip) {
			// Fail closed — shared 'unknown' bucket was an unfair DoS vector.
			return region_response('Too Many Requests', { status: 429 });
		}

		const id = url.searchParams.get('id') ?? '';
		const payload = url.searchParams.get('props') ?? '';
		const exp_raw = url.searchParams.get('exp') ?? '';
		const sig = url.searchParams.get('sig') ?? '';

		// Length/charset gate BEFORE HMAC (P5-HMAC-CPU). Ids are always 12-hex from the transform.
		if (!REGION_ID_RE.test(id) || payload.length > MAX_REGION_PROPS_LEN) {
			return region_response('Forbidden', { status: 403 });
		}

		const exp = Number(exp_raw);
		if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
			return region_response('Forbidden', { status: 403 });
		}

		// Pre-HMAC probe — forged floods hit this, not render() (HMAC-CPU-DOS).
		if (this.probe_rate.limited(ip)) {
			return region_response('Too Many Requests', { status: 429 });
		}

		// Optional session bind: cookie value must match the session sealed into the MAC.
		const session = session_cookie ? (event.cookies.get(session_cookie) ?? '') : '';

		// Verify before consulting the manifest — bad MAC never distinguishes unknown vs known id.
		if (!verify(secret, region_mac_message(id, exp_raw, payload, session), sig)) {
			return region_response('Forbidden', { status: 403 });
		}

		// Valid capability — now charge the per-IP render budget.
		if (this.render_rate.limited(ip)) {
			return region_response('Too Many Requests', { status: 429 });
		}

		if (!Object.hasOwn(island_modules, id)) {
			return region_response('Forbidden', { status: 403 });
		}
		const load = island_modules[id];
		if (typeof load !== 'function') {
			return region_response('Forbidden', { status: 403 });
		}

		let props: unknown;
		try {
			// Module eval first — registers transportable codecs the reviver needs (cold start).
			await load();
			props = devalue.parse(B64Url.decode(payload), {
				[TRANSPORT_WIRE_KEY]: (d: never) => revive_transportable(d, false)
			});
		} catch {
			// Same status as bad MAC — no decode oracle (STATUS-ORACLE).
			return region_response('Forbidden', { status: 403 });
		}
		if (props === null || typeof props !== 'object' || Array.isArray(props)) {
			return region_response('Forbidden', { status: 403 });
		}

		const body = await this.#render_component(load, props as Record<string, unknown>);
		if (body === null) {
			return region_response('Region render failed', { status: 500 });
		}

		if (body.length > MAX_REGION_BODY) {
			return region_response('Forbidden', { status: 403 });
		}

		if (method === 'HEAD') {
			return region_response(null, {
				status: 200,
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'content-length': String(new TextEncoder().encode(body).byteLength),
					'cache-control': 'private, max-age=30'
				}
			});
		}

		return region_response(body, {
			status: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				// `private` keeps shared/CDN caches out (responses are cookie-personalized) while
				// letting THIS browser reuse the `<link rel="preload">` response for the runtime
				// fetch (a short max-age is enough; the runtime fetches each region once).
				'cache-control': 'private, max-age=30'
			}
		});
	}
}

/**
 * Options for {@link handle}.
 */
export interface OgygiaHandleOptions {
	/**
	 * Path (relative to Kit `base`) the handle serves.
	 * Default is the clash-safe island-emoji route (`/🏝️`). Must start with `/`.
	 */
	endpoint?: string;
}

/**
 * Build a Kit `handle` that serves signed deferred-region / lake-remount HTML and injects page
 * seeds for island hydration. Server-only.
 *
 * ```ts
 * // src/hooks.server.ts
 * import * as ogygia from 'ogygia/server';
 * export const handle = ogygia.handle();
 * ```
 *
 * @param options - Optional endpoint path override. See {@link OgygiaHandleOptions}.
 * @returns A SvelteKit {@link Handle} suitable for `sequence(ogygia.handle(), …)`.
 */
// Also surfaced here so `import * as ogygia from 'ogygia/server'` has `ogygia.transport` — but the
// actual Kit transport hook must live in the UNIVERSAL hooks (client needs decode), so wire it
// from `'ogygia'` in src/hooks.ts, not here.
export { ogygiaTransport as transport } from './transport.js';

export function handle(options: OgygiaHandleOptions = {}): Handle {
	const instance = new OgygiaHandle(options);
	return (args) => instance.handle(args);
}
