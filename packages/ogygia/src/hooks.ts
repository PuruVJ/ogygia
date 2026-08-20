/**
 * SvelteKit server `handle` for signed region holes (`defer` / remount:`swr`).
 *
 * Serves `GET <base>/__ogygia__?id=…&props=…&exp=…&sig=…` by verifying the region MAC,
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
import { islands as island_modules, island_url } from 'virtual:ogygia/server-manifest';
import { islandCss, fnManifest } from 'virtual:ogygia/island-deps';
import { create_remote_key } from 'virtual:ogygia/kit-wire';
import { REGION_BRAND } from './region-brand.js';
import { secret } from 'virtual:ogygia/secret';
import { rateLimit as rate_limit_cfg } from 'virtual:ogygia/rate-limit';
import { sessionCookie as session_cookie } from 'virtual:ogygia/session-cookie';
import {
	enabled as router_enabled,
	viewTransitions as router_view_transitions,
	speculationRules as mpa_speculation_rules
} from 'virtual:ogygia/router-config';
import runtime_url from 'virtual:ogygia/runtime-url';
import dev_hmr_url from 'virtual:ogygia/dev-hmr-url';
import { verify, region_mac_message } from './server/hmac.js';
import { render_cache_key, cached_render } from './server/render-cache.js';
import { B64Url } from './server/payload.js';
import { REF_WIRE_KEY, ref_reviver } from './ref.js';
// PULL-registration at decode time (idempotent; no import-time side effects).
import { register_wire_kind } from './live-transport.js';
import { register_store_kind, register_derived_kind } from './store-transport.js';
import { register_snippet_kind } from './region-snippet.js';
import { register_fn_kind } from './fn-transport.js';
import {
	DEFAULT_ISLANDS_ENDPOINT,
	MAX_REGION_PROPS_LEN,
	REGION_ID_RE,
	REGION_TTL_RE
} from './server/endpoint.js';
import { build_parcel, done_parcel } from './server/stream-regions.js';
import {
	page_declares_router_meta,
	page_declares_runtime_script,
	page_declares_dev_hmr_script,
	page_declares_speculation_rules
} from './server/head-presence.js';
import { html_has_kit_bootstrap } from './runtime/kit-boot.js';
import { RateLimiter } from './server/rate-limit.js';
import { PageSeed } from './server/page-seed.js';
import { has_deferred, stage_deferred, settle_deferred, resolve_script, page_seed_reducers, type Deferred } from './server/page-stream.js';
import { PAGE_DEFER_BOOTSTRAP, PAGE_DEFER_GLOBAL } from './page-defer.js';
import { ConcurrencyGate, REGION_RENDER_CONCURRENCY } from './runtime/concurrency.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { stringify } from 'devalue';
import { serialize_provided_context } from './context-bridge.js';
import { escape_script_text } from './escape.js';
import { PAGE_CTX_MARKER, set_ctx_recorder } from './context-registry.js';
import { set_page_recorder, type PageSnapshot } from './page-seed-registry.js';

/** Hard cap on rendered region HTML (bytes). */
const MAX_REGION_BODY = 2_000_000;

// Drop-in `setContext` bridge. A layout that imports `setContext` from `ogygia` records each string
// key into this per-request bag during SSR; `inject_client_seeds` reads it back and emits ONE
// `<script data-ogygia-provide-page>` before `</body>` that every island seeds `getContext` from —
// so a plain `setContext` in a csr=false layout reaches child islands (separate hydration roots).
// Server-only (this file never ships to the browser), so `node:async_hooks` stays out of the client
// bundle; on the client the recorder is never installed and `record_ctx` is a no-op.
// One per-request bag holds every SSR-time ogygia capture the handle needs back at seed time:
//   ctx  — drop-in `setContext(key, value)` values (see above).
//   page — the page snapshot ($page.data / form / error / status). The handle can't read the
//          resolved load data (Kit merges it locally in render.js, never on RequestState, and
//          `$app/state.page` throws in a hook), so Region.svelte reads Kit's REAL page during SSR
//          and records it here; the seed below merges it in. That's how `$page.data` works in islands.
//   deferred — page.data/form promises staged for STREAMING (real browser loads only). Set during
//          the render; `handle` streams a resolve script per promise after the doc ships.
type RequestBag = {
	ctx: Map<string, unknown>;
	page: PageSnapshot | null;
	deferred: Deferred[] | null;
	/** Next free defer id after data+form staging — re-staging (nested promises) continues from here. */
	defer_next_id: number;
	/** devalue reducers for streamed resolve scripts (app transport encoders + defer marker). */
	seed_reducers: Record<string, (v: unknown) => unknown> | null;
};
const request_als = new AsyncLocalStorage<RequestBag>();
set_ctx_recorder((key, value) => {
	const bag = request_als.getStore();
	if (bag) bag.ctx.set(key, value);
});
set_page_recorder((snapshot) => {
	const bag = request_als.getStore();
	if (bag) bag.page = snapshot;
});

/** Cap on a batch POST body before `request.json()` buffers it. 32 endpoints × ~8.5kB (props cap
 *  8192 + URL overhead) ≈ 270kB; 512kB leaves margin. Rejected up front via `content-length`. */
const MAX_BATCH_BODY = 512 * 1024;

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

/**
 * Stylesheet `<link>`s a server-picked region needs so a page that never imported the component
 * still styles the fetched HTML (the whole point of a held region — the page can't know which
 * component the server will choose). Tagged `data-ogygia-region-css` so the client runtime HOISTS
 * them into `<head>`: a body `<link>` wouldn't load inside a `<template>` batch parcel, and a head
 * link loads once and is deduped across regions. Empty for a plain island (its CSS is already in the
 * page's own stylesheet) or before a build (`islandCss` reads the build-time handoff).
 */
function region_css_links(id: string): string {
	const url = island_url[id];
	if (!url) return '';
	let out = '';
	for (const href of islandCss(url)) {
		out += `<link rel="stylesheet" href="${href}" data-ogygia-region-css>`;
	}
	return out;
}

/**
 * Wrap a devalue payload as an `application/ogygia-*` side-channel `<script>` the runtime reads. The
 * `payload` MUST already be escaped by its serializer (via `escape_script_text`) — every serializer
 * here does — so this only builds the tag. One spot for the side-channel shape (page / remote / ctx).
 */
function emit_ogygia_script(subtype: string, escaped_payload: string, marker = ''): string {
	return `<script type="application/ogygia-${subtype}"${marker ? ' ' + marker : ''}>${escaped_payload}</script>`;
}

class OgygiaHandle {
	readonly #endpoint: string;
	readonly render_rate: RateLimiter;
	readonly probe_rate: RateLimiter;

	constructor(options: OgygiaHandleOptions = {}) {
		// Stored WITHOUT a base prefix. Getting the app's absolute base path inside a hook has no
		// public, forward-compatible API — `base` from `$app/paths` is deprecated (removed in Kit 3)
		// and `resolve()` is page-relative here — so instead of prefixing the base we match the request
		// pathname by SUFFIX (see `handle`). The endpoint is a clash-safe path, so a suffix match is
		// unambiguous regardless of `paths.base`.
		this.#endpoint = options.endpoint || DEFAULT_ISLANDS_ENDPOINT;
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
		// sends matches our raw-emoji literal regardless of how Kit hands us the URL. Suffix match
		// (not `===`) so it works under any `paths.base` without needing the base at all: the request
		// arrives at `<base>/__ogygia__`, and the endpoint is a leading-slash, clash-safe path.
		if (!path.endsWith(this.#endpoint)) {
			// Flicker fix: on csr=false pages Kit resolves top-level `await query()` calls during
			// SSR (populating the internal request store's `remote.implicit`) but only serializes
			// them into the page when csr===true. We capture the resolved query responses and emit
			// a `<script type="application/ogygia-remote">` side-channel the runtime reads to seed
			// the reused client query cache BEFORE islands hydrate — so no re-fetch, no flash. The
			// store is captured synchronously here (active inside Kit's `with_request_store`); it is
			// the SAME object reference Kit mutates during the render inside `resolve`.
			const store = try_get_request_store();
			// Per-request capture bag: `setContext` values + the page snapshot are recorded during the
			// render (inside this `run`, so `getStore()` works) and read back in `inject_client_seeds`
			// via the SAME bag reference passed through as a closure.
			const bag: RequestBag = { ctx: new Map(), page: null, deferred: null, defer_next_id: 0, seed_reducers: null };
			const response = await request_als.run(bag, () =>
				resolve(event, {
					transformPageChunk: async ({ html }) =>
						this.inject_client_seeds(html, store?.state, event, bag)
				})
			);
			// Stream captured `$page.data` promises into islands (csr=false, real browser load). The doc
			// — with the pending seed + resolve-global bootstrap — is fully built now (transformPageChunk
			// ran synchronously inside `resolve`); the tail streams a resolve script per promise as it
			// settles. Only set when the request could consume a stream (see `inject_client_seeds`).
			if (bag.deferred && bag.deferred.length) {
				return this.stream_page_deferred(response, bag.deferred, bag.defer_next_id, bag.seed_reducers ?? undefined);
			}
			return response;
		}
		// POST to the endpoint = a BATCH frame stream (client-side navigation, single-flight): render a set
		// of signed region calls and flush each as an out-of-order frame in one response.
		if (event.request.method.toUpperCase() === 'POST') return await this.render_batch(event);
		return await this.render_region(event);
	};

	/**
	 * Batch frame stream (client navigation, single-flight). POST body: a JSON `string[]` of signed
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
		// A batch is at most MAX_BATCH signed endpoints (~8.5kB each), so a well-formed body is a few
		// hundred kB. `request.json()` buffers the WHOLE body before we can slice to 32 — reject an
		// oversized body up front (O(1) header check) so a single padded POST can't force a large
		// buffer. Platform adapters cap the body too, but this makes the bound explicit and covers
		// adapters that don't. (Chunked uploads without content-length still rely on the platform cap.)
		const content_length = Number(event.request.headers.get('content-length'));
		if (Number.isFinite(content_length) && content_length > MAX_BATCH_BODY) {
			return region_response('Payload Too Large', { status: 413 });
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
		event?: RequestEvent,
		bag?: RequestBag
	): Promise<string> {
		// csr=true page — Kit serializes its own remotes and hydrates the whole tree; skip seeds.
		if (html_has_kit_bootstrap(html)) return html;

		// Router (global, opt out with `ogygia({ router: false })`). The handle owns the runtime
		// bootstrap + the `ogygia-router` meta the client router reads per-navigation, so no
		// `<Router/>` component is needed. Every injection is presence-checked, so it composes with
		// what a page already emits:
		//  • an island page already carries `data-ogygia-runtime` (Region emits it) → we skip it, and
		//    only load-only pages get the runtime injected here;
		//  • a page can override view transitions per-route by emitting its own
		//    `<meta name="ogygia-router" content="plain">` — present → we leave it, so the page wins.
		// The runtime URL is root-relative (base-correct for `base: ''`); island pages under a base
		// path get the base-correct URL from Region's `asset()`, so only base-path + island-less pages
		// are affected — a rare follow-up.
		//
		// Every presence check matches a REAL element, not the tag's name as TEXT — a page that
		// DOCUMENTS one of these tags in a code block (the changelog does) renders it escaped, which a
		// bare `html.includes('name="ogygia-router"')` false-matches, suppressing the injection. See
		// `head-presence.ts` for why that dropped documented pages to full-page navigation.
		const has_router_meta = page_declares_router_meta(html);
		const has_runtime_script = page_declares_runtime_script(html);
		const has_dev_hmr_script = page_declares_dev_hmr_script(html);
		const has_speculation_rules = page_declares_speculation_rules(html);
		// MPA mode (`router: false`): no SPA machinery ships — the browser owns navigation, so the
		// handle injects static Speculation Rules instead. Chromium prerenders likely next pages,
		// Firefox prefetches them, everything else ignores the JSON. Presence-checked so a page
		// authoring its own rules wins; per-link opt-out via `data-ogygia-speculate="off"`.
		if (!router_enabled && mpa_speculation_rules && !has_speculation_rules && html.includes('</head>')) {
			html = html.replace(
				'</head>',
				`<script type="speculationrules" data-ogygia-speculate>${mpa_speculation_rules}</script></head>`
			);
		}
		if (router_enabled) {
			const head: string[] = [];
			if (!has_router_meta) {
				head.push(`<meta name="ogygia-router" content="${router_view_transitions ? 'vt' : 'plain'}">`);
			}
			if (runtime_url && !has_runtime_script) {
				head.push(`<script type="module" data-ogygia-runtime src="${runtime_url}"></script>`);
			}
			if (dev_hmr_url && !has_dev_hmr_script) {
				head.push(`<script type="module" data-ogygia-dev-hmr src="${dev_hmr_url}"></script>`);
				// The page's sub-app scope (its route id's first segment) for the dev CSS bridge:
				// a changed stylesheet joins this page only when the plugin derives the same scope
				// among its owners — two route-group sub-apps never paint each other in dev.
				const scope = (event.route.id ?? '').split('/').filter(Boolean)[0] ?? '';
				head.push(`<meta name="ogygia-dev-scope" content="${scope.replace(/"/g, '')}">`);
			}
			if (head.length && html.includes('</head>')) {
				html = html.replace('</head>', head.join('') + '</head>');
			}
		}

		// Body-level seeds (page / remote / setContext) go in the FINAL chunk only. Under a streamed
		// render the early chunks have no `</body>` AND no rendered island yet — so the captured page
		// data (Region records it during the island render) isn't ready. Gating here means the seed is
		// built once, after the render, with the real `data`. Head injections above already ran.
		if (!html.includes('</body>')) return html;

		const scripts: string[] = [];

		// Single page seed (PAGE-DUP) — islands read it through the `$app/state` shim. url/params/route
		// come from the RequestEvent (reading `$app/state`'s `page` in a hook throws
		// `lifecycle_outside_component`). data/form/error/status come from the page snapshot
		// Region.svelte records during SSR from Kit's REAL page — the only place the resolved load data
		// is reachable (Kit merges it locally in render.js, never on RequestState). PAGE-SEED-EVENT.
		const page_snap = bag?.page;
		let seed_data = page_snap?.data;
		let seed_form = page_snap?.form;
		// Merge the app's universal `transport` ENCODERS (custom types the app teaches Kit) with the
		// DeferRef/SettledRef marker reducers, so a load's custom types round-trip into islands — not
		// just built-in devalue types. A no-op for the common promise-free / transport-free seed.
		const transport_encoders = Object.fromEntries(
			Object.entries(state?.transport ?? {}).map(([name, codec]) => [name, codec.encode])
		);
		const seed_reducers = { ...transport_encoders, ...page_seed_reducers };
		const seed_stringify = ((v: unknown) => stringify(v, seed_reducers)) as typeof stringify;
		// A load may return promises at any level (Kit streaming). csr=false can't hydrate the PAGE, so
		// Kit's own resolve stream is dead there — but an ISLAND has a client. Two paths:
		//  • Real browser load (`Sec-Fetch-Mode: navigate`) can consume a stream — STAGE each promise to a
		//    marker (a pending Promise on the client) and stream a resolve `<script>` per settle after the
		//    doc ships (`stream_page_deferred`, drains Kit's dead tail). Inline bootstrap defines the
		//    resolve global before any resolve script runs.
		//  • Programmatic fetch (SPA/router, mode ≠ navigate) can't run streamed scripts, so SETTLE the
		//    promises here and seed resolved values — no hang, same as before.
		// Gated on `has_deferred` so the common (no-promise) seed pays only a cheap probe walk.
		const has_pending = !!page_snap && (has_deferred(page_snap.data) || has_deferred(page_snap.form));
		const can_stream = event?.request.headers.get('sec-fetch-mode') === 'navigate';
		if (has_pending && can_stream) {
			const staged_data = stage_deferred(page_snap!.data, 0);
			const staged_form = stage_deferred(page_snap!.form, staged_data.next_id);
			seed_data = staged_data.staged;
			seed_form = staged_form.staged;
			if (bag) {
				bag.deferred = [...staged_data.deferred, ...staged_form.deferred];
				bag.defer_next_id = staged_form.next_id; // real next id — do NOT recompute from array length
				bag.seed_reducers = seed_reducers; // resolve scripts encode with the same transport + defer
			}
			scripts.push(`<script>${PAGE_DEFER_BOOTSTRAP}</script>`);
		} else if (has_pending) {
			seed_data = await settle_deferred(page_snap!.data);
			seed_form = await settle_deferred(page_snap!.form);
		}
		const page_payload = event
			? PageSeed.serialize(
					{
						url: event.url,
						params: event.params,
						route: event.route,
						status: page_snap?.status ?? 200,
						data: seed_data,
						form: seed_form,
						error: page_snap?.error
					},
					seed_stringify
				)
			: null;
		if (page_payload) {
			scripts.push(emit_ogygia_script('page', page_payload, 'data-ogygia-page'));
		}

		if (state?.remote?.implicit) {
			const remote_script = await this.build_remote_seed_script(state);
			if (remote_script) scripts.push(remote_script);
		}

		// og.$ factories (PROD, CSP-clean): one EXECUTING inline script seeds the tag → factory
		// map before any island hydrates — the fn kind resolves against it with no eval. Emitted
		// only when the client build's handoff carries hoists (dev: the fn-manifest virtual is
		// complete; null here). Executing-inline is the same CSP class as the defer bootstrap.
		const fnm = fnManifest();
		if (fnm) {
			const entries = Object.entries(fnm)
				.map(([tag, src]) => `${JSON.stringify(tag)}:(${src})`)
				.join(',');
			scripts.push(
				`<script data-ogygia-fnm>globalThis.__OG_FNM=Object.assign(globalThis.__OG_FNM||{},{${entries}});</script>`
			);
		}

		// Drop-in `setContext` page root — emitted here (final chunk) so every `setContext` has run.
		const provided = bag?.ctx;
		if (provided?.size) {
			// Drops any non-serializable value (function / store / class instance) instead of crashing.
			const payload = serialize_provided_context(provided);
			if (payload) {
				scripts.push(emit_ogygia_script('ctx', payload, PAGE_CTX_MARKER));
			}
		}

		if (scripts.length === 0) return html;
		// FUNCTION-form replacement: seed payloads legitimately contain `$$` (e.g. an og.$ factory
		// source with a literal `$` before a template hole) — a STRING replacement would collapse
		// it (String.replace's `$$` escape) and silently corrupt the shipped code/data.
		const injected = scripts.join('') + '</body>';
		return html.replace('</body>', () => injected);
	}

	/**
	 * Stream the captured `$page.data` promises into islands (csr=false, real browser load). The
	 * document — carrying the pending seed + resolve-global bootstrap — is already built by `resolve`;
	 * here we (1) forward it, (2) DRAIN Kit's own dead csr=false resolve tail so its
	 * `__sveltekit_<hash> is not defined` never reaches the browser, and (3) emit one
	 * `<script>__ogygia_page_resolve(id, ok, value)</script>` per promise AS IT SETTLES — completion
	 * order, non-blocking. Each island's `{#await page.data.x}` flips pending → resolved live.
	 */
	stream_page_deferred(
		response: Response,
		deferred: Deferred[],
		initial_next_id: number,
		reducers?: Record<string, (v: unknown) => unknown>
	): Response {
		const source = response.body;
		if (!source) return response;
		const reader = source.getReader();
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				// 1. Forward Kit's document through `</body></html>` (one enqueue in practice). Kit streams
				//    its (dead) resolve scripts only AFTER this, as separate chunks. Accumulate the decoded
				//    text ACROSS reads so a `</body>` split over a chunk boundary is still detected (the
				//    stateful decoder alone returns only the current chunk).
				let doc = '';
				try {
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						controller.enqueue(value);
						doc += decoder.decode(value, { stream: true });
						if (doc.includes('</body>')) break;
					}
				} catch {
					/* fall through — resolution streaming below still runs */
				}
				// 2. Read + discard Kit's dead resolve tail so it never reaches the client and Kit's own
				//    stream closes cleanly (best-effort, runs alongside our resolution streaming).
				void (async () => {
					try {
						for (;;) {
							const { done } = await reader.read();
							if (done) break;
						}
					} catch {
						/* ignore */
					}
				})();
				// 3. Our resolve script per promise, streamed as each settles; close once all have.
				//    A promise may RESOLVE to a value that itself holds promises (Kit re-defers those
				//    recursively). We mirror it: re-stage each settled value, stream the staged value
				//    (nested markers and all), and stream those nested promises too — ids continue past
				//    the initial set. `pending` grows as nested promises appear, so the stream stays open
				//    until the whole tree has settled. `next_id` is the initial contiguous count.
				let pending = deferred.length;
				let next_id = initial_next_id;
				let closed = false;
				const maybe_close = () => {
					if (pending === 0 && !closed) {
						closed = true;
						try {
							controller.close();
						} catch {
							/* already closed */
						}
					}
				};
				const push = (id: number, ok: boolean, value: unknown) => {
					try {
						controller.enqueue(encoder.encode(resolve_script(PAGE_DEFER_GLOBAL, id, { ok, value }, reducers)));
					} catch {
						/* client gone / stream already closed */
					}
				};
				const stream_one = (id: number, promise: PromiseLike<unknown>) => {
					Promise.resolve(promise).then(
						(value) => {
							const { staged, deferred: nested, next_id: after } = stage_deferred(value, next_id);
							next_id = after;
							push(id, true, staged);
							pending += nested.length;
							for (const n of nested) stream_one(n.id, n.promise);
							pending -= 1;
							maybe_close();
						},
						(error) => {
							push(id, false, error);
							pending -= 1;
							maybe_close();
						}
					);
				};
				for (const { id, promise } of deferred) stream_one(id, promise);
				maybe_close();
			},
			cancel() {
				reader.cancel().catch(() => {});
			}
		});
		const headers = new Headers(response.headers);
		headers.delete('content-length');
		return new Response(stream, { status: response.status, statusText: response.statusText, headers });
	}

	/**
	 * True when a remote's resolved value (deep) contains a region carrying baked SSR HTML — a
	 * page-sized render, not seed data (see the skip in {@link build_remote_seed_script}). Depth-capped:
	 * a region ticket sits shallow in any sane payload (a DocView's `entry.body` is 2 levels deep).
	 */
	has_baked_region(value: unknown, depth = 0): boolean {
		if (depth > 6 || value === null || typeof value !== 'object') return false;
		const r = value as Record<PropertyKey, unknown>;
		if (r[REGION_BRAND] === true && typeof r.html === 'string') return true;
		if (Array.isArray(value)) return value.some((x) => this.has_baked_region(x, depth + 1));
		for (const k in r) if (this.has_baked_region(r[k], depth + 1)) return true;
		return false;
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
							// A seed is DATA; a value carrying a BAKED region (SSR HTML in the ticket — a
							// page body from a `doc`-style remote) is a page-sized RENDER, and the page that
							// awaited it server-side has already rendered it. Seeding it would ship the body
							// twice (measured ~130kb/page on a docs site); skip it — a client consumer that
							// ever needs the value just fetches the remote.
							if (resolved && !this.has_baked_region(v)) data[bucket][remote_key] = { v };
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
		return emit_ogygia_script('remote', escape_script_text(devalue.stringify(data, reducers)));
	}

	/**
	 * `render()` the island under the concurrency gate + timeout. Returns the HTML body, or `null`
	 * if the render threw or timed out. Shared by the endpoint ({@link render_region}) and the
	 * batch path ({@link #render_capability}).
	 */
	async #render_component(
		load: () => Promise<{ default: unknown }>,
		props: Record<string, unknown>,
		cache?: { key: string; ttl: number }
	): Promise<string | null> {
		// R6/G2: the ONE cache-fronted render seam. `cached_render` serves a memo when the hole opted
		// into a positive `maxAge` (key carries the session seal — a per-user render never crosses
		// users); on a miss it runs the render_body below. The ENDPOINT wraps its render in the
		// concurrency gate + timeout (the inline-island path, sharing `cached_render`, does not).
		try {
			return await cached_render(
				() =>
					render_gate.run(async () => {
						const mod = await load();
						const rendered = render(mod.default as Component<Record<string, unknown>>, { props });
						return await Promise.race([
							Promise.resolve(rendered).then((out) => out.body as string),
							new Promise<never>((_, rej) =>
								setTimeout(() => rej(new Error('region render timeout')), RENDER_TIMEOUT_MS)
							)
						]);
					}),
				cache,
				Date.now()
			);
		} catch {
			return null;
		}
	}

	/** The session cookie value sealed into a region capability (empty when no `sessionCookie` is
	 *  configured) — the same read the MAC verify uses, and the per-user part of the render-cache key. */
	#region_session(event: RequestEvent): string {
		return session_cookie ? (event.cookies.get(session_cookie) ?? '') : '';
	}

	// ── Shared capability core ──────────────────────────────────────────────────────────────────
	// The endpoint ({@link render_region}) and the batch path ({@link #render_capability}) MUST verify
	// identically — a one-sided change to the MAC message or the props reviver would weaken auth on one
	// path only. The three security-critical steps live here, once. Each caller keeps its OWN failure
	// shaping (403/500 + rate-limit interleaving vs null→client-fetch), which is where they legitimately
	// differ; only the trust decisions are shared.

	/** Charset/length/expiry gate — cheap, runs BEFORE any HMAC (P5-HMAC-CPU). */
	#capability_gate_ok(id: string, payload: string, ttl_raw: string, exp_raw: string): boolean {
		if (!REGION_ID_RE.test(id) || payload.length > MAX_REGION_PROPS_LEN || !REGION_TTL_RE.test(ttl_raw)) return false;
		const exp = Number(exp_raw);
		return Number.isFinite(exp) && exp >= Math.floor(Date.now() / 1000);
	}

	/** THE auth check: session-bound region MAC verify. */
	#verify_region_mac(id: string, payload: string, exp_raw: string, ttl_raw: string, sig: string, event: RequestEvent): boolean {
		// The capability seals the session cookie (if any) into the signed message.
		const session = session_cookie ? (event.cookies.get(session_cookie) ?? '') : '';
		return verify(secret, region_mac_message(id, exp_raw, payload, session, ttl_raw), sig);
	}

	/** Eval the island module (registers transportable codecs the reviver needs on a cold-start defer),
	 *  then decode + revive the props payload. Null on parse failure or a non-object/array result. */
	async #decode_region_props(payload: string, load: () => Promise<unknown>): Promise<Record<string, unknown> | null> {
		let props: unknown;
		try {
			await load();
			// universal decode; remember:false — the SERVER never memoizes (per-request isolation)
			register_wire_kind();
			register_store_kind();
			register_snippet_kind();
			register_fn_kind();
			register_derived_kind();
			props = devalue.parse(B64Url.decode(payload), {
				[REF_WIRE_KEY]: ref_reviver(false) as (d: never) => unknown
			});
		} catch {
			return null;
		}
		if (props === null || typeof props !== 'object' || Array.isArray(props)) return null;
		return props as Record<string, unknown>;
	}

	/**
	 * Batch (single-flight navigation): verify a hole's OWN signed capability URL and render it in-process. Same
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

		if (!this.#capability_gate_ok(id, payload, ttl_raw, exp_raw)) return null;
		if (!this.#verify_region_mac(id, payload, exp_raw, ttl_raw, sig, event)) return null;

		if (!Object.hasOwn(island_modules, id)) return null;
		const load = island_modules[id];
		if (typeof load !== 'function') return null;

		const props = await this.#decode_region_props(payload, load);
		if (!props) return null;

		const ttl = Number(ttl_raw) || 0;
		const cache =
			ttl > 0
				? { key: render_cache_key(id, payload, this.#region_session(event)), ttl }
				: undefined;
		const body = await this.#render_component(load, props, cache);
		if (body === null || body.length > MAX_REGION_BODY) return null;
		// CSS links ride in the parcel; the client hoists them to <head> (a body/parcel link is inert
		// inside the `<template>` box), so a batched server-island still styles a page that never
		// imported its component.
		return { slot: sig, html: region_css_links(id) + body };
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

		// Length/charset/expiry gate BEFORE HMAC (P5-HMAC-CPU). Ids are always 12-hex from the transform;
		// `ttl` (cache max-age seconds) is signed, but charset-gate it here so a forged value can't
		// reach the response header before verify rejects it.
		if (!this.#capability_gate_ok(id, payload, ttl_raw, exp_raw)) {
			return region_response('Forbidden', { status: 403 });
		}

		// Pre-HMAC probe — forged floods hit this, not render() (HMAC-CPU-DOS).
		if (this.probe_rate.limited(ip)) {
			return region_response('Too Many Requests', { status: 429 });
		}

		// Verify (session-bound) before consulting the manifest — bad MAC never distinguishes unknown
		// vs known id.
		if (!this.#verify_region_mac(id, payload, exp_raw, ttl_raw, sig, event)) {
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

		// Same status as bad MAC on any decode failure — no decode oracle (STATUS-ORACLE).
		const props = await this.#decode_region_props(payload, load);
		if (!props) {
			return region_response('Forbidden', { status: 403 });
		}

		const ttl = Number(ttl_raw) || 0;
		const cache =
			ttl > 0
				? { key: render_cache_key(id, payload, this.#region_session(event)), ttl }
				: undefined;
		const body = await this.#render_component(load, props, cache);
		if (body === null) {
			return region_response('Region render failed', { status: 500 });
		}

		if (body.length > MAX_REGION_BODY) {
			return region_response('Forbidden', { status: 403 });
		}

		// Ship the component's stylesheet links ahead of its HTML (the client hoists them to <head>).
		const html = region_css_links(id) + body;

		if (method === 'HEAD') {
			return region_response(null, {
				status: 200,
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'content-length': String(new TextEncoder().encode(html).byteLength),
					'cache-control': cache_control
				}
			});
		}

		return region_response(html, {
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
	 * Default is the clash-safe island-emoji route (`/__ogygia__`). Must start with `/`.
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
