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
import { islands as island_modules } from 'virtual:ogygia/server-manifest';
import { create_remote_key } from 'virtual:ogygia/kit-wire';
import { secret } from 'virtual:ogygia/secret';
import { rateLimit as rate_limit_cfg } from 'virtual:ogygia/rate-limit';
import { sessionCookie as session_cookie } from 'virtual:ogygia/session-cookie';
import { verify, region_mac_message } from './server/hmac.js';
import { B64Url } from './server/payload.js';
import { TRANSPORT_WIRE_KEY, revive_transportable } from './live-transport.js';
import {
	DEFAULT_ISLANDS_ENDPOINT,
	MAX_REGION_PROPS_LEN,
	REGION_ID_RE,
	REGION_TTL_RE
} from './server/endpoint.js';
import { build_parcel, done_parcel } from './server/stream-regions.js';
import { html_has_kit_bootstrap } from './runtime/kit-boot.js';
import { RateLimiter } from './server/rate-limit.js';
import { PageSeed } from './server/page-seed.js';
import { ConcurrencyGate, REGION_RENDER_CONCURRENCY } from './runtime/concurrency.js';

/** Hard cap on rendered region HTML (bytes). */
const MAX_REGION_BODY = 2_000_000;

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
			return await resolve(event, {
				transformPageChunk: async ({ html }) =>
					this.inject_client_seeds(html, store?.state, event)
			});
		}
		// POST to the endpoint = a BATCH frame stream (client-side navigation / weaving): render a set
		// of signed region calls and flush each as an out-of-order frame in one response.
		if (event.request.method.toUpperCase() === 'POST') return await this.render_batch(event);
		return await this.render_region(event);
	};

	/**
	 * Batch frame stream (client navigation / route weaving). POST body: a JSON `string[]` of signed
	 * region endpoints — the calls the client needs. Renders them in parallel and flushes each as a
	 * `<template data-ogygia-slot="sig">…</template>` frame the moment IT settles (out of order); a
	 * done sentinel ends it. One response, many frames. Every call carries its own MAC so there's no
	 * extra auth; same-origin + per-IP budget mirror the single-region path.
	 */
	async render_batch(event: RequestEvent): Promise<Response> {
		const MAX_BATCH = 32;
		if (event.request.headers.get('sec-fetch-site') === 'cross-site') {
			return region_response('Forbidden', { status: 403 });
		}
		const ip = client_ip(event);
		if (!ip) return region_response('Too Many Requests', { status: 429 });
		if (this.probe_rate.limited(ip) || this.render_rate.limited(ip)) {
			return region_response('Too Many Requests', { status: 429 });
		}
		let parsed: unknown;
		try {
			parsed = await event.request.json();
		} catch {
			return region_response('Bad Request', { status: 400 });
		}
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return region_response('Bad Request', { status: 400 });
		}
		const calls = parsed.filter((e): e is string => typeof e === 'string').slice(0, MAX_BATCH);
		const render = (endpoint: string) => this.#render_capability(endpoint, event);
		const encoder = new TextEncoder();

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				// Each call renders independently; enqueue its frame on settle, whatever the order.
				await Promise.all(
					calls.map(async (endpoint) => {
						const out = await render(endpoint).catch(() => null);
						const parcel = out ? build_parcel(out.slot, out.html) : null;
						if (parcel) controller.enqueue(encoder.encode(parcel));
					})
				);
				controller.enqueue(encoder.encode(done_parcel()));
				controller.close();
			}
		});

		return region_response(stream, {
			status: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'x-accel-buffering': 'no'
			}
		});
	}

	/**
	 * Document-level side-channels: one page snapshot + optional remote query seed.
	 * Skips Kit-booted (csr=true) pages which serialize remotes themselves.
	 */
	async inject_client_seeds(
		html: string,
		state: RequestState | undefined,
		event?: RequestEvent
	): Promise<string> {
		// csr=true page — Kit serializes its own remotes and hydrates the whole tree; skip seeds.
		if (html_has_kit_bootstrap(html)) return html;

		const scripts: string[] = [];

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

		// Mirror Kit's OWN seed bucketing (server/remote.js) over the side-channel — Kit only serializes
		// remote data inline when csr===true, so on csr=false pages we do it here. Bucket every implicit
		// remote by type: q(query) / p(prerender) / l(query.live) / f(form). Seeding PRERENDER remotes
		// (not only queries) is the fix for the async-island FOUC: a prerender remote awaited inside an
		// island otherwise re-fetches on hydrate, so the component re-renders and Svelte RE-MOUNTS the
		// subtree — a frame of unstyled DOM. With the seed in `prerender_responses`, the client resolves
		// it synchronously and never re-fetches. Keys use `create_remote_key`, exactly like Kit's client.
		const data: Record<'q' | 'p' | 'l' | 'f', Record<string, { v: unknown }>> = {
			q: {},
			p: {},
			l: {},
			f: {}
		};
		for (const [internals, record] of implicit) {
			// Private (non-exported) remotes have no id and must never be serialized.
			if (!internals.id) continue;
			const type = internals.type as string;
			const bucket = type === 'query_live' ? 'l' : (type[0] as 'q' | 'p' | 'l' | 'f');
			if (bucket !== 'q' && bucket !== 'p' && bucket !== 'l' && bucket !== 'f') continue;
			for (const key in record) {
				// form outputs are keyed by the client-side action id directly (Kit parity).
				const remote_key = type === 'form' ? key : create_remote_key(internals.id, key);
				const promise = state.remote.data?.get(internals)?.[key] ?? record[key]();
				let resolved = true;
				await Promise.race([
					Promise.resolve(promise).then(
						(v) => {
							if (resolved) data[bucket][remote_key] = { v };
						},
						() => {
							/* errored/pending remotes are omitted → the client fetches them itself */
						}
					),
					Promise.resolve().then(() => {
						resolved = false;
					})
				]);
			}
		}

		if (!Object.values(data).some((b) => Object.keys(b).length > 0)) return null;

		const transport = state.transport || {};
		const reducers = Object.fromEntries(
			Object.entries(transport).map(([name, codec]) => [name, codec.encode])
		);
		const payload = devalue.stringify(data, reducers).replaceAll('<', '\\u003C');
		return `<script type="application/ogygia-remote">${payload}</script>`;
	}

	/**
	 * `render()` the island under the concurrency gate + timeout. Returns the HTML body, or `null`
	 * if the render threw or timed out. Shared by the endpoint ({@link render_region}) and the
	 * batch path ({@link #render_capability}).
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
	 * Batch (route weaving): verify a hole's OWN signed capability URL and render it in-process. Same
	 * trust boundary as the endpoint (verify the MAC before touching the manifest), but every failure —
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
		const ttl_raw = params.get('ttl') ?? '';
		const sig = params.get('sig') ?? '';

		if (!REGION_ID_RE.test(id) || payload.length > MAX_REGION_PROPS_LEN || !REGION_TTL_RE.test(ttl_raw))
			return null;
		const exp = Number(exp_raw);
		if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;

		// The capability was minted this same request, sealing the same session cookie (if any). `ttl`
		// is part of the signed message even though the batch renders inline (no per-hole HTTP cache).
		const session = session_cookie ? (event.cookies.get(session_cookie) ?? '') : '';
		if (!verify(secret, region_mac_message(id, exp_raw, payload, session, ttl_raw), sig)) return null;

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
		const ttl_raw = url.searchParams.get('ttl') ?? '';
		const sig = url.searchParams.get('sig') ?? '';

		// Length/charset gate BEFORE HMAC (P5-HMAC-CPU). Ids are always 12-hex from the transform;
		// `ttl` (cache max-age seconds) is signed, but charset-gate it here so a forged value can't
		// reach the response header before verify rejects it.
		if (!REGION_ID_RE.test(id) || payload.length > MAX_REGION_PROPS_LEN || !REGION_TTL_RE.test(ttl_raw)) {
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
		if (!verify(secret, region_mac_message(id, exp_raw, payload, session, ttl_raw), sig)) {
			return region_response('Forbidden', { status: 403 });
		}

		// Cache policy travels signed in the URL: a positive `ttl` opts this hole into a private browser
		// cache; absent/0 keeps it dynamic (`no-store`). A hole is fresh-per-request by default.
		const cache_control = ttl_raw ? `private, max-age=${Number(ttl_raw)}` : 'no-store';

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
					'cache-control': cache_control
				}
			});
		}

		return region_response(body, {
			status: 200,
			headers: {
				'content-type': 'text/html; charset=utf-8',
				// Per-hole policy signed into the URL (see `cache_control` above). A hole is `no-store`
				// (dynamic) unless it opts into caching via its preset's `maxAge`, which mints a positive
				// `ttl` → `private, max-age=ttl`. `private` keeps shared/CDN caches out (responses are
				// cookie-personalized) while still letting THIS browser reuse the response.
				'cache-control': cache_control
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
