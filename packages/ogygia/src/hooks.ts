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
import { profilerConfig } from 'virtual:ogygia/profiler-config';
import { freezeConfig } from 'virtual:ogygia/freeze-config';
import { freeze_routes, freeze_pages } from 'virtual:ogygia/freeze-routes';
import { router_freeze_verdict } from './freeze/routers.js';
import {
	set_kit_page_reader,
	set_kit_event_reader,
	kit_render_context
} from './server/kit-context.js';
import { absolutize_hole_html } from './server/hole-urls.js';
import { KEEP_FALLBACK_HTML, is_keep_fallback } from './keep-fallback.js';
import { serve_federation, install_federation } from './federation/serve.js';

// Install the deferred-hole signer once (it holds the region secret); a no-op until a `federate()`
// registers. Cheap and idempotent, at module eval like the other seams.
install_federation();
import {
	freeze_get,
	freeze_put,
	join_flight,
	begin_flight,
	self_evict,
	current_edges,
	type FlightOutcome
} from './freeze/registry.js';
import { observe_event, type Observation } from './freeze/observe.js';
import { stitch_html, stitch_modes, esi_rewrite } from './freeze/stitch.js';
import { set_freeze_capture_reader, set_source_recorder } from './freeze/capture.js';
import type { FreezeEntry } from './freeze/types.js';
import { building, dev } from '$app/environment';
import runtime_url from 'virtual:ogygia/runtime-url';
import dev_hmr_url from 'virtual:ogygia/dev-hmr-url';
import { asset } from '$app/paths';
import devtools_boot_url from 'virtual:ogygia/devtools-boot-url';
import { verify, region_mac_message } from './server/hmac.js';
import { render_cache_key, cached_render } from './server/render-cache.js';
import { B64Url } from './server/payload.js';
import { REF_WIRE_KEY, ref_reviver } from './ref.js';
import { prime_flags, flush_exposures, set_flag_observer } from './flags.js';
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
	page_declares_speculation_rules,
	dedupe_head_links,
	runtime_first
} from './server/head-presence.js';
import { locate, assemble } from './server/document-assembly.js';
import { error_route_is_csr_true, route_is_csr_true } from './context.js';
import { merge_seed_ask, shape_page_data } from './server/seed-shape.js';
import { html_has_kit_bootstrap } from './runtime/kit-boot.js';
import { RateLimiter } from './server/rate-limit.js';
import { PageSeed } from './server/page-seed.js';
import { analyze, index_seed, set_measure_memo_reader, type MeasureMemo } from './seed-refs.js';
import { WIRE_FORMAT_ATTR, WIRE_FORMAT_JSON } from './server/props-wire.js';
import {
	stage_deferred,
	settle_deferred,
	resolve_script,
	page_seed_reducers,
	type Deferred
} from './server/page-stream.js';
import { PAGE_DEFER_BOOTSTRAP, PAGE_DEFER_GLOBAL } from './page-defer.js';
import { ConcurrencyGate, REGION_RENDER_CONCURRENCY } from './runtime/concurrency.js';
import { createHash } from 'node:crypto';
import { stringify } from 'devalue';
import { serialize_provided_context } from './context-bridge.js';
import { escape_script_text } from './escape.js';
import { PAGE_CTX_MARKER, set_ctx_recorder } from './context-registry.js';
import { set_page_recorder, type PageSnapshot } from './page-seed-registry.js';
import { collect_remote_seed } from './server/remote-seed-gate.js';
import { DocumentTail, set_tail_reader } from './server/document-tail.js';
import { region_css_tag } from './server/region-css.js';
import { set_late_recorder, set_late_taker, type LateRegion } from './late-region-registry.js';
import {
	record_request_stats,
	record_hole_stats,
	request_stats_detailed,
	type SeedKeyStat
} from './server/request-stats.js';
import { json_culprit } from './seed-refs.js';
import type { SeedAsk } from './server/seed-shape.js';
import { set_server_devtools_recorder, record_server_event } from './devtools/server-registry.js';
import { DEVTOOLS_SCHEMA_VERSION, type DevtoolsEvent } from './devtools/schema.js';

/** Hard cap on rendered region HTML (bytes). */
const MAX_REGION_BODY = 2_000_000;

// DEVTOOLS gate — server realm. The SSR bundle carries the `__OGYGIA_DEVTOOLS__` define; off → the
// recorder is never installed and every `if (DEVTOOLS)` folds out.
const DEVTOOLS = typeof __OGYGIA_DEVTOOLS__ !== 'undefined' ? __OGYGIA_DEVTOOLS__ : false;
/** High-res clock for server-realm devtools timestamps. */
const dt_now = () =>
	typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

// Drop-in `setContext` bridge. A layout that imports `setContext` from `ogygia` records each string
// key into this per-request bag during SSR; `inject_client_seeds` reads it back and emits ONE
// `<script data-ogygia-provide-page>` before `</body>` that every island seeds `getContext` from —
// so a plain `setContext` in a csr=false layout reaches child islands (separate hydration roots).
// Server-only (this file never ships to the browser); on the client the recorder is never installed
// and `record_ctx` is a no-op.
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
	/** Some region on the page reads `$page` on the client (Region.svelte × `islandReadsPage`), so
	 *  the `application/ogygia-page` seed must ship. The snapshot itself is recorded regardless. */
	seed_wanted: boolean;
	/** SEED SHAPING: the union of the regions' asks — the `page.data` keys to ship, or `'all'`
	 *  (some region's reads could not be pinned). `null` until a region asks (then `seed_wanted`). */
	seed_keys: import('./server/seed-shape.js').SeedKeys | null;
	/** each region's own ask, by entry — the seed explainer's "who reads what" (detail only) */
	seed_asks: Map<string, SeedAsk> | null;
	/** The remote modules (Kit id-hashes) some region's client code on this page can call — the
	 *  union of every `record_page` (Region.svelte × `islandRemotes`). Gates the
	 *  `application/ogygia-remote` seed: an SSR-resolved remote outside the set ships no seed.
	 *  `null` once any region answered fail-open ("may call anything") → every remote seeds. */
	remotes_wanted: Set<string> | null;
	/** THE DOCUMENT TAIL (server/document-tail.ts): the module-preload hints and props sidecars the
	 *  regions of this Kit page render defer to the end of the body. Emitted once, before the seeds. */
	tail: DocumentTail;
	/** ONE WALK PER NODE PER REQUEST (seed-refs.ts): every tree measured during this request — the
	 *  page seed, each island's props, the shaped seed — shares this memo, so a block island whose
	 *  props ARE a seed node costs a lookup, not a second walk of the block. */
	measure_memo: MeasureMemo;
	deferred: Deferred[] | null;
	/** Next free defer id after data+form staging — re-staging (nested promises) continues from here. */
	defer_next_id: number;
	/** LATE REGIONS registered during the render (`<Region of={promise}>` on a streamed router
	 *  page) — the router drains these into completion-order template chunks. */
	late: LateRegion[] | null;
	late_next: number;
	/** devalue reducers for streamed resolve scripts (app transport encoders + defer marker). */
	seed_reducers: Record<string, (v: unknown) => unknown> | null;
	/** FREEZE: this render may be stored (capture in flight) — region capabilities minted
	 *  during it go prerender-grade (the stored HTML outlives `regionTtl`). */
	freeze_capture: boolean;
	/** FREEZE: the live personalization-read observation for the verdict (flag reads mark it
	 *  through `set_flag_observer`); null when this render is not a capture candidate. */
	freeze_obs: Observation | null;
	/** FREEZE: og.source receipts recorded during a capture render (`s:<id>:<fp>`) — stored
	 *  with the entry as the reverse index; null when not capturing. */
	freeze_tags: string[] | null;
};
// ONE REQUEST STORE: Kit's. Kit runs every request inside its own AsyncLocalStorage
// (`with_request_store`): the handle, every `await` of the Svelte render, the streamed tail chunks
// all see it. Kit re-enters a NEW store object for the render (`render_response` wraps the render
// in `{ event, state }` of its own, with a traced copy of the event), so the one identity that is
// stable across the whole request is the `Request` itself — the bag hangs off it in a WeakMap, and
// every reader below resolves it through `try_get_request_store().event.request`. No second ALS:
// on Node 20/22 each ALS in flight copies its store on every async hop, and a 2.6 MB async Svelte
// render is hundreds of thousands of hops (~0.2 s measured for one ALS on such a page). The bag
// dies with the request (WeakMap), so nothing is deleted or leaked.
const bags = new WeakMap<Request, RequestBag>();
/** This request's bag, or `undefined` outside a Kit page request (a hole endpoint, a remote-function
 *  call, a render with no Kit store around it). */
function bag_of(): RequestBag | undefined {
	const request = (try_get_request_store() as { event?: RequestEvent } | undefined)?.event?.request;
	return request ? bags.get(request) : undefined;
}
set_ctx_recorder((key, value) => {
	const bag = bag_of();
	if (bag) bag.ctx.set(key, value);
});
set_page_recorder((snapshot, seed, remotes, entry) => {
	const bag = bag_of();
	if (!bag) return;
	// MERGE: the routeless document root records url/params/route from the router's seed first;
	// Region.svelte's data/form/error/status record must not wipe them (and vice versa).
	bag.page = { ...bag.page, ...snapshot };
	// SEED ONLY WHEN READ, AND ONLY WHAT IS READ: one island whose client code reads `$page` is
	// enough to ship the seed; the union of the islands' key asks decides how much of `page.data`.
	if (seed !== false) {
		bag.seed_wanted = true;
		bag.seed_keys = merge_seed_ask(bag.seed_keys, seed);
	}
	// the profiler's seed explainer: who asked for what (detail only — a Map write per region)
	if (bag.seed_asks && entry && seed !== false) bag.seed_asks.set(entry, seed);
	// REMOTE SEED ONLY WHEN REACHABLE: union the remotes this region's client can call; one
	// fail-open record (`null`) opens the whole set for the request.
	if (remotes === null) bag.remotes_wanted = null;
	else if (bag.remotes_wanted) for (const h of remotes) bag.remotes_wanted.add(h);
});
// THE DOCUMENT TAIL (server/document-tail.ts): hints + props sidecars a Kit page render defers to
// the end of the body. One per request, created with the bag; only a render inside a Kit PAGE
// request has a bag, so a hole endpoint, a remote-function render or a router document keeps its
// hints in the head and its sidecars adjacent.
set_tail_reader(() => bag_of()?.tail ?? null);
// The request's shared measure memo (seed-refs.ts): a hole endpoint, a remote-function render or a
// router document has no bag, so each of its roots is measured on its own — as before.
set_measure_memo_reader(() => bag_of()?.measure_memo ?? null);
// Kit's `__request__` context for every server render root ogygia starts (document root, inline
// island, deferred endpoint, snippet body): rebuilt from the recorded page snapshot, with the live
// event filling url/params/route when the snapshot has none (a Kit page: Kit's own values; a
// deferred endpoint: the endpoint's request — an island rendering in isolation sees no page).
/** The islands endpoint path the handle serves (the constructor updates it when configured). */
let islands_endpoint_path: string = DEFAULT_ISLANDS_ENDPOINT;

/**
 * The PAGE a render belongs to. A hole renders in its own request (`/__ogygia__?…`); a component
 * inside it reading `$page.url` — for the locale, a country name, a cookie prefix — must see the
 * page, not the endpoint. The runtime's same-origin fetch carries the page as `Referer`
 * (`strict-origin-when-cross-origin` sends the full URL same-origin), so the endpoint request
 * answers with it; anything else (no referer, cross-origin, an ESI subrequest) keeps its own URL.
 */
function page_url_of(event: RequestEvent | undefined): URL | undefined {
	if (!event) return undefined;
	if (!event.url.pathname.endsWith(islands_endpoint_path)) return event.url;
	const referer = event.request.headers.get('referer');
	if (!referer) return event.url;
	try {
		const page = new URL(referer);
		if (page.origin === event.url.origin) return page;
	} catch {
		/* malformed referer — fall through */
	}
	return event.url;
}

// The live event for `requestEvent()` (public): what a server island reads its `locals` /
// `cookies` / `url` from, in the request that renders it — no `$app/server` in the component.
set_kit_event_reader(
	() => (try_get_request_store() as { event?: RequestEvent } | undefined)?.event ?? null
);
set_kit_page_reader(() => {
	const bag = bag_of();
	const event = (try_get_request_store() as { event?: RequestEvent } | undefined)?.event;
	if (!bag && !event) return null;
	const snap = bag?.page ?? {};
	return {
		url: snap.url?.href ? new URL(snap.url.href) : page_url_of(event),
		params: snap.params ?? event?.params ?? {},
		route: snap.route ?? { id: event?.route.id ?? null },
		status: snap.status ?? 200,
		data: snap.data ?? {},
		form: snap.form ?? null,
		error: snap.error ?? null,
		state: {}
	};
});
// LATE REGIONS: a promise `of` registers per request; the id keys the region's slot wrapper AND
// its later template chunk. The taker DRAINS (the router reads once, post-render).
set_late_recorder((promise) => {
	const bag = bag_of();
	if (!bag) return null;
	const id = `r${bag.late_next++}`;
	(bag.late ??= []).push({ id, promise });
	return id;
});
set_late_taker(() => {
	const bag = bag_of();
	if (!bag?.late?.length) return null;
	const list = bag.late;
	bag.late = null;
	return list;
});
// FREEZE: region capabilities minted during a may-be-stored render go prerender-grade — the
// region-endpoint mint reads this per-request flag (see freeze/capture.ts for why it's a seam).
set_freeze_capture_reader(() => bag_of()?.freeze_capture === true);
// FREEZE: a flag read during an eligible render personalizes the page — disqualify it, named
// like a cookie read (`flag:<name>`). Priming alone never disqualifies; only actual reads do.
set_flag_observer((name) => {
	const obs = bag_of()?.freeze_obs;
	if (obs && obs.disqualified_by === null) obs.disqualified_by = `flag:${name}`;
});
// FREEZE: og.source receipts — every `__og_source`-wrapped call during a capture render files
// its `(id, fingerprint)` tag here; stored with the entry as the reverse index for
// `freeze.invalidate(fn, args)`.
set_source_recorder((tag) => {
	const bag = bag_of();
	if (bag?.freeze_capture) (bag.freeze_tags ??= []).push(tag);
});
// DEVTOOLS: per-request event buffers, keyed off the request bag by a side WeakMap so RequestBag stays
// pristine (and free) when devtools is off. GC'd with the bag; never a global ring (which would mix
// concurrent SSR requests). Unreferenced ⇒ tree-shaken when the gate is off.
const dt_buffers = new WeakMap<RequestBag, { events: DevtoolsEvent[]; seq: number }>();
// Stamp the envelope with THIS request's own seq/clock and push into its buffer.
if (DEVTOOLS)
	set_server_devtools_recorder((input) => {
		const bag = bag_of();
		if (!bag) return;
		const buf = dt_buffers.get(bag);
		if (!buf) return;
		buf.events.push({
			...input,
			v: DEVTOOLS_SCHEMA_VERSION,
			seq: buf.seq++,
			t: dt_now(),
			realm: 'server'
		});
	});

/** Cap on a batch POST body before `request.json()` buffers it. 32 endpoints × ~8.5kB (props cap
 *  8192 + URL overhead) ≈ 270kB; 512kB leaves margin. Rejected up front via `content-length`. */
const MAX_BATCH_BODY = 512 * 1024;

/** Abort waiting on slow region SSR (work may continue — see INVARIANTS · RENDER-TIMEOUT). */
const RENDER_TIMEOUT_MS = 10_000;

/** Process-local cap on concurrent region SSR (M1 CPU amp under valid MAC). */
const render_gate = new ConcurrencyGate(REGION_RENDER_CONCURRENCY);

/** Drop Kit's `(group)` segments from a `route.id`, matching the compiler's `normalize_route_id` so
 *  a request matches the group-stripped `freeze_routes` set. Pure string ops — no regex. */
function strip_route_groups(id: string): string {
	const segs = id
		.split('/')
		.filter(Boolean)
		.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
	return '/' + segs.join('/');
}

/**
 * FREEZE opt-in for a request: is this route's effective `freeze` true? Three worlds, in the order
 * dispatch itself resolves them:
 * 1. A mounted programmatic `routes()` table that CLAIMS the pathname (it answers inside this
 *    handle, ahead of any file route): its declared page > layout > table value; claimed but
 *    undeclared (`null`) = the config `default`.
 * 2. A Kit PAGE route (`event.route.id` in `freeze_pages`): its compile-time cascaded value —
 *    membership in `freeze_routes`.
 * 3. Anything else — an endpoint route (`+server.ts`, catch-all or not) or a request no file
 *    route claimed (`route.id` null): the config `default`. A null id must NEVER be normalized to
 *    `/` and matched against the root page's entry — that is a different route.
 */
function freeze_route_optin(route_id: string | null | undefined, pathname: string): boolean {
	const verdict = router_freeze_verdict(pathname);
	if (typeof verdict === 'boolean') return verdict;
	if (verdict === undefined && route_id != null) {
		const id = strip_route_groups(route_id);
		if (freeze_pages.has(id)) return freeze_routes.has(id);
	}
	return freezeConfig?.default === true;
}

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

function region_response(
	body: BodyInit | null,
	init: { status: number; headers?: Record<string, string> }
) {
	return new Response(body, {
		status: init.status,
		headers: { ...REGION_FRAME_HEADERS, ...init.headers }
	});
}

/**
 * Decode a request pathname without throwing on malformed percent-encoding (SEC-05).
 * @returns decoded path, or null if the encoding is invalid
 */
type ResolveOpts = NonNullable<Parameters<Parameters<Handle>[0]['resolve']>[1]>;

/** Two `resolve()` option sets as one: the inner transform (the core's document injection) runs
 *  first, the outer (the profiler's) sees the finished chunk; the other options merge, outer last. */
function compose_resolve_opts(inner?: ResolveOpts, outer?: ResolveOpts): ResolveOpts | undefined {
	if (!inner) return outer;
	if (!outer) return inner;
	const a = inner.transformPageChunk;
	const b = outer.transformPageChunk;
	return {
		...inner,
		...outer,
		transformPageChunk: !a
			? b
			: !b
				? a
				: async (input) => {
						const first = await a(input);
						if (first === undefined) return first;
						return b({ ...input, html: first });
					}
	};
}

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
		// `asset()` supplies base/assets — islandCss hrefs are baked base-less (see Region.svelte).
		// Inline under Kit's `inlineStyleThreshold`, a link otherwise (server/region-css.ts).
		out += region_css_tag(href, asset(href));
	}
	return out;
}

/**
 * Wrap a payload as an `application/ogygia-*` side-channel `<script>` the runtime reads. The
 * `payload` MUST be `<`-safe already: devalue output is by construction (it writes `<`), a
 * JSON payload goes through `escape_script_text` first — so this only builds the tag. One spot for
 * the side-channel shape (page / remote / ctx / devtools).
 */
function emit_ogygia_script(subtype: string, escaped_payload: string, marker = ''): string {
	return `<script type="application/ogygia-${subtype}"${marker ? ' ' + marker : ''}>${escaped_payload}</script>`;
}

// ── FREEZE (render-on-write) ────────────────────────────────────────────────────────────────

/** Kit's boot declares its deferred map ONLY on pages with pending (streamed) load promises —
 *  verified against @sveltejs/kit 2.70 (render.js: `blocks.push('const deferred = new Map();')`). */
const KIT_DEFERRED_BOOT_RE = /const deferred = new Map\(\);/;
const DOUBLE_QUOTE_G = /"/g;
/** Stamped into the head of a csr=true document: the runtime reads it (`kit_hydrates_page`)
 *  instead of scanning the page's inline scripts for Kit's bootstrap. */
const CSR_META = '<meta name="ogygia-csr" content="true">';

/** Stamped into SERVED-FROM-STORE documents (never the fresh `stored` response): the runtime
 *  reads it so `render: 'live'` lakes treat first mount as a STALE mount and revalidate —
 *  the stored copy is by definition a cached render, exactly what remount:'swr' exists for. */
const FREEZE_DOC_META = '<meta name="ogygia-freeze" content="hit">';

/** Rebuild a Response from a stored freeze. `via` rides a debug header the harness asserts on.
 *  With the incoming `request`, a matching validator answers 304 — plain-HTTP conditional
 *  requests (RFC 9110), which is what makes an Akamai/CloudFront/browser revalidation of a
 *  stored page cost zero body bytes. Validators live on the ENTRY (freeze level), never in
 *  edge adapters: they are the render's identity, not a CDN dialect. */
function freeze_response(
	entry: FreezeEntry,
	via: 'hit' | 'join' | 'stored',
	request?: Request
): Response {
	if (entry.kind === 'redirect') {
		return new Response(null, {
			status: entry.status,
			headers: { location: entry.location, 'x-ogygia-freeze': via }
		});
	}
	if (request) {
		const etag = entry.headers.etag;
		const inm = request.headers.get('if-none-match');
		const ims = request.headers.get('if-modified-since');
		const last_modified = entry.headers['last-modified'];
		const etag_match = !!etag && !!inm && inm.split(',').some((t) => t.trim() === etag);
		// If-None-Match wins when present (RFC 9110 §13.1.3); IMS compares against store time.
		const ims_match =
			!inm && !!ims && !!last_modified && Date.parse(ims) >= Date.parse(last_modified);
		if (etag_match || ims_match) {
			const headers: Record<string, string> = { 'x-ogygia-freeze': via };
			for (const h of ['etag', 'last-modified', 'cache-control'] as const) {
				if (entry.headers[h]) headers[h] = entry.headers[h];
			}
			return new Response(null, { status: 304, headers });
		}
	}
	return new Response(served_html(entry, via), {
		status: 200,
		headers: { ...entry.headers, 'x-ogygia-freeze': via }
	});
}

/** The stored page as served: copies served FROM the store carry the doc marker so live regions
 *  self-freshen (`stored` = the render that JUST happened — fresh by definition, no marker). The
 *  marker goes in by slicing at the entry's `</head>` (recorded at capture; found once for an
 *  entry written before the field existed) — never a `replace` over a multi-MB page per hit. */
function served_html(entry: Extract<FreezeEntry, { kind: 'page' }>, via: string): string {
	if (via === 'stored') return entry.html;
	const at = entry.head_end ?? entry.html.indexOf('</head>');
	return at === -1 ? entry.html : entry.html.slice(0, at) + FREEZE_DOC_META + entry.html.slice(at);
}

/** The verdict's other word: a REFUSED page gets `private, no-store` when the app set nothing —
 *  per-page proven headers replace blanket CDN rules in both directions. Best-effort (some
 *  platforms hand out immutable headers). */
function stamp_no_store(response: Response): void {
	try {
		if (response.status !== 200) return;
		if (!(response.headers.get('content-type') ?? '').includes('text/html')) return;
		if (response.headers.get('cache-control')) return;
		response.headers.set('cache-control', 'private, no-store');
	} catch {
		/* immutable headers — the app's platform wins */
	}
}

/** DEV teaching leg: the verdict runs but never stores/serves. Eligible → a `would-store`
 *  header to read in the network panel; refused → ONE console note per path naming the read. */
const dev_noted_paths = new Set<string>();
function dev_freeze_note(
	response: Response,
	path: string,
	bag: RequestBag,
	obs: Observation
): void {
	const refusal =
		obs.disqualified_by ??
		(obs.wrote_cookie ? 'a cookie write' : null) ??
		(response.status !== 200 ? `status ${response.status}` : null) ??
		(response.headers.has('set-cookie') ? 'a set-cookie response header' : null) ??
		(!(response.headers.get('content-type') ?? '').includes('text/html')
			? 'a non-html response'
			: null) ??
		(bag.deferred && bag.deferred.length ? 'streamed load promises' : null);
	if (!refusal) {
		try {
			response.headers.set('x-ogygia-freeze', 'would-store');
		} catch {
			/* immutable headers */
		}
		return;
	}
	if (dev_noted_paths.has(path)) return;
	dev_noted_paths.add(path);
	console.warn(
		`[ogygia] freeze: ${path} stays per-request — the render read ${refusal}. ` +
			`Personalize inside a render:'deferred' hole to make the shell storable.`
	);
}

/**
 * The write-path verdict + store. Returns the stored entry AND a fresh Response (reading the
 * body consumes the original) — or null when the page must stay per-request. Pre-body guards
 * run FIRST so an ineligible response's stream is never consumed.
 */
async function capture_freeze(
	response: Response,
	path: string,
	bag: RequestBag,
	obs: Observation
): Promise<{ entry: FreezeEntry; response: Response } | null> {
	const ttl = freezeConfig!.ttl;
	// Personalization observed (cookie/header/locals/flag read, or a cookie write) → per-request.
	if (obs.disqualified_by || obs.wrote_cookie) {
		if (dev && obs.disqualified_by) {
			console.warn(
				`[ogygia] freeze: ${path} stays per-request — the render read ${obs.disqualified_by}. ` +
					`Personalize inside a render:'deferred' hole to make the shell storable.`
			);
		}
		return null;
	}
	// Permanent redirects are the hottest cheap wins (canonical 301s) — store status + location.
	if (response.status === 301 || response.status === 308) {
		const location = response.headers.get('location');
		if (!location) return null;
		const entry: FreezeEntry = {
			kind: 'redirect',
			status: response.status,
			location,
			created: Date.now()
		};
		await freeze_put(path, entry, { ttl, tags: bag.freeze_tags ?? [] });
		return { entry, response };
	}
	if (response.status !== 200) return null;
	if (response.headers.has('set-cookie')) return null;
	const content_type = response.headers.get('content-type') ?? '';
	if (!content_type.includes('text/html')) return null;
	const app_cc = response.headers.get('cache-control') ?? '';
	if (app_cc.includes('private') || app_cc.includes('no-store')) return null;
	if (bag.deferred && bag.deferred.length) return null; // streamed page — always per-request
	const html = await response.text();
	// Belt and braces for streamed pages WITHOUT regions (no page snapshot to probe): Kit's boot
	// only declares its deferred-map when the page carries pending promises — buffering such a
	// response bakes ONE settle's inline resolve scripts into the copy. Never store it.
	if (KIT_DEFERRED_BOOT_RE.test(html)) return null;
	const created = Date.now();
	// STITCH holes, two modes (freeze/stitch.ts):
	//  - `stitch="serve"` flips the entry's nature: the SHELL stores (renders once), but every
	//    serve is per-visitor (holes re-render + splice at ORIGIN). So: no shared-cache headers, no
	//    edge instructions, no validators — a 304 would skip the re-stitch. Edge policy: BYPASS.
	//    One serve hole taints the whole page (edge holes on it are served-stitched too).
	//  - `stitch="edge"` (only): the page stays a NORMAL edge-cacheable entry — its holes are
	//    rewritten into ESI includes the CDN fills per request (shell from cache, origin renders
	//    one region), and the entry is stamped `Surrogate-Control: content="ESI/1.0"` so an
	//    ESI-capable edge processes them. Validators are minted over the REWRITTEN bytes.
	const modes = stitch_modes(html);
	const has_serve = modes.serve;
	const stored_html = !has_serve && modes.edge ? esi_rewrite(html, path) : html;
	// The verdict's storage instructions: ours first, then each edge's (an edge may grant its own
	// cache-control — later wins). Merged into the STORED entry too, so hits replay them.
	// Validators ride the entry: the etag IS the render's identity, `last-modified` its store
	// time — every later revalidation (Akamai prefresh, browser reload) can answer 304.
	const headers: Record<string, string> = has_serve
		? { 'content-type': content_type, 'cache-control': 'private, no-store' }
		: {
				'content-type': content_type,
				'cache-control': `public, s-maxage=${ttl}`,
				etag: `"${createHash('sha256').update(stored_html).digest('hex').slice(0, 32)}"`,
				'last-modified': new Date(created).toUTCString(),
				...(modes.edge ? { 'surrogate-control': 'content="ESI/1.0"' } : {})
			};
	if (!has_serve) {
		for (const edge of current_edges()) {
			try {
				Object.assign(headers, edge.headers({ url: path, ttl }));
			} catch {
				/* an edge adapter must never fail a render */
			}
		}
	}
	const entry: FreezeEntry = {
		kind: 'page',
		html: stored_html,
		head_end: stored_html.indexOf('</head>'),
		headers,
		created,
		...(has_serve ? { stitch: true } : {})
	};
	await freeze_put(path, entry, { ttl, tags: bag.freeze_tags ?? [] });
	return { entry, response: freeze_response(entry, 'stored') };
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
		islands_endpoint_path = this.#endpoint;
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

	/** Constructed profiler handle, or null when `ogygia({ profiler })` is off. `undefined` = not yet
	 *  resolved (the dynamic import runs once, on the first request). */
	#profiler: Handle | null | undefined;

	/** Lazily import + construct the profiler from `virtual:ogygia/profiler-config`. The profiler's
	 *  weight (node:inspector, crypto, its UI-rendering path) enters a SEPARATE chunk that loads only
	 *  when configured — so an app that doesn't use it pays nothing, and hooks.server.ts never mentions
	 *  it. The secret is read from OGYGIA_PROFILER_SECRET at runtime unless the config baked one. */
	async #ensure_profiler(): Promise<Handle | null> {
		if (this.#profiler !== undefined) return this.#profiler;
		if (!profilerConfig) return (this.#profiler = null);
		try {
			const { profiler } = await import('./profiler/index.js');
			// a runtime store (set via `setProfilerStore` in hooks.server.ts) — a live DB object the
			// build-time config could not carry; merged over the serializable config here
			const { getProfilerStore } = await import('./profiler/storage/index.js').catch(() => ({ getProfilerStore: () => undefined }));
			const store = getProfilerStore();
			this.#profiler = profiler({ ...(profilerConfig as Parameters<typeof profiler>[0]), ...(store ? { store } : {}) });
		} catch {
			this.#profiler = null; // profiler unavailable (edge without node:inspector, etc.)
		}
		return this.#profiler;
	}

	// The public handle: when the profiler is configured (vite plugin only) it wraps the core handle,
	// so it times the SSR render and serves its UI — with zero hooks wiring. Otherwise it's the core.
	handle: Handle = async ({ event, resolve }) => {
		const prof = await this.#ensure_profiler();
		if (prof) {
			// The profiler's `resolve` options (its beacon tag's transformPageChunk) compose with the
			// core's own transform: the core's runs first (the document is complete), then the profiler's.
			return prof({
				event,
				resolve: (e, outer) =>
					this.#core({
						event: e,
						resolve: (ev, inner) => resolve(ev, compose_resolve_opts(inner, outer))
					})
			});
		}
		return this.#core({ event, resolve });
	};

	#core: Handle = async ({ event, resolve }) => {
		const path = decode_pathname(event.url.pathname);
		if (path === null) {
			return new Response('Bad Request', { status: 400 });
		}
		// Resolve the flag SOURCE (if `decide({ source })` set one) ONCE per request — HERE, above
		// the endpoint/page split, so page renders, remote-function calls, AND the region endpoint
		// (deferred/live holes — the per-visitor leg of a CDN-cached page, where flag reads matter
		// most) all see the same primed decisions. Sync reads after; no-op without a source.
		await prime_flags({ request: event.request, url: event.url, cookies: event.cookies });
		// FRAGMENT FEDERATION: a `federate()` in hooks.server.ts serves `/og/fragment/*`, `/og/thaw`,
		// and the deferred-hole endpoint straight from the handle (no route files). Null = not a
		// federation path → fall through. Above the freeze/page split: these are their own protocol.
		const fed_res = await serve_federation(event);
		if (fed_res) return fed_res;
		// Compare against the DECODED request pathname so the percent-encoded UTF-8 the browser
		// sends matches our raw-emoji literal regardless of how Kit hands us the URL. Suffix match
		// (not `===`) so it works under any `paths.base` without needing the base at all: the request
		// arrives at `<base>/__ogygia__`, and the endpoint is a leading-slash, clash-safe path.
		if (!path.endsWith(this.#endpoint)) {
			// FREEZE read path (render-on-write): GET, no query string, not prerendering. A hit
			// serves the stored bytes — Kit, loads, and Svelte never run. A concurrent cold miss
			// JOINS the in-flight render (the stampede law: N concurrent requests, ONE render).
			let freeze_settle: ((outcome: FlightOutcome) => void) | null = null;
			let freeze_obs: Observation | null = null;
			const freeze_page_request =
				freezeConfig !== null &&
				!building &&
				event.request.method.toUpperCase() === 'GET' &&
				event.url.search === '' &&
				!path.endsWith('__data.json') &&
				freeze_route_optin(event.route?.id, path);
			if (freeze_page_request && !dev) {
				const hit = await freeze_get(path);
				if (hit) {
					if (DEVTOOLS)
						record_server_event({ domain: 'server', name: 'server.freeze', op: 'hit', url: path });
					return hit.kind === 'page' && hit.stitch
						? await this.#serve_stitched(hit, 'hit', event)
						: freeze_response(hit, 'hit', event.request);
				}
				const flight = join_flight(path);
				if (flight) {
					const outcome = await flight;
					if (outcome.stored) {
						if (DEVTOOLS)
							record_server_event({
								domain: 'server',
								name: 'server.freeze',
								op: 'join',
								url: path
							});
						return outcome.stored.kind === 'page' && outcome.stored.stitch
							? await this.#serve_stitched(outcome.stored, 'join', event)
							: freeze_response(outcome.stored, 'join', event.request);
					}
					// The flight proved the page ineligible — render per-request, no new flight
					// (a chain of flights would serialize renders of a page that never stores).
				} else {
					// First cold request: open the flight + observe the render for the verdict.
					freeze_settle = begin_flight(path);
					freeze_obs = observe_event(event);
				}
			} else if (freeze_page_request && dev) {
				// DEV: never serve from (or fill) the store — an edited page must always re-render,
				// HMR truth beats byte reuse. The OBSERVATION still runs so the purity verdict can
				// teach: eligible pages get an `x-ogygia-freeze: would-store` header, refusals a
				// once-per-path console note naming the disqualifying read.
				freeze_obs = observe_event(event);
			}
			// Flicker fix: on csr=false pages Kit resolves top-level `await query()` calls during
			// SSR (populating the internal request store's `remote.implicit`) but only serializes
			// them into the page when csr===true. We capture the resolved query responses and emit
			// a `<script type="application/ogygia-remote">` side-channel the runtime reads to seed
			// the reused client query cache BEFORE islands hydrate — so no re-fetch, no flash. The
			// store is captured synchronously here (active inside Kit's `with_request_store`); it is
			// the SAME object reference Kit mutates during the render inside `resolve`.
			const store = try_get_request_store();
			// Per-request capture bag: `setContext` values + the page snapshot are recorded during the
			// render (the readers above find it through Kit's store) and read back in
			// `inject_client_seeds` via the SAME bag reference passed through as a closure.
			const bag: RequestBag = {
				ctx: new Map(),
				page: null,
				seed_wanted: false,
				seed_keys: null,
				seed_asks: request_stats_detailed() ? new Map() : null,
				remotes_wanted: new Set(),
				tail: new DocumentTail(),
				measure_memo: new Map(),
				deferred: null,
				defer_next_id: 0,
				late: null,
				late_next: 0,
				seed_reducers: null,
				freeze_capture: freeze_settle !== null,
				freeze_obs,
				freeze_tags: freeze_settle !== null ? [] : null
			};
			// DEVTOOLS: attach a request-scoped event buffer via a side WeakMap (keeps RequestBag — and
			// its cost — untouched when devtools is off; the map + this line DCE out then).
			if (DEVTOOLS) dt_buffers.set(bag, { events: [], seq: 0 });
			// Hang the bag off the request for the rest of it — the render's own Kit store and the
			// streamed tail chunks (late regions, resolve scripts, after `resolve()` returned) all
			// carry this same `Request` and find it.
			bags.set(event.request, bag);
			let response: Response;
			try {
				response = await resolve(event, {
					transformPageChunk: async ({ html }) =>
						this.inject_client_seeds(html, store?.state, event, bag)
				});
			} finally {
				flush_exposures(); // drain queued exposures at the request's end (serverless-safe tail)
			}
			// FREEZE: action self-evict — a successful mutation on a page URL evicts its freeze
			// (mirrors Kit's actions-invalidate-loads semantics; origin store only, fire-and-forget).
			if (
				freezeConfig !== null &&
				event.request.method.toUpperCase() !== 'GET' &&
				response.status < 400
			) {
				self_evict(path);
			}
			// FREEZE write path: verdict + store. A failed flight ALWAYS settles (joiners in the
			// stampede must never hang), and a store problem never fails the request.
			if (freeze_settle) {
				try {
					const stored = await capture_freeze(response, path, bag, freeze_obs!);
					freeze_settle({ stored: stored?.entry ?? null });
					if (DEVTOOLS) {
						record_server_event(
							stored
								? {
										domain: 'server',
										name: 'server.freeze',
										op: 'stored',
										url: path,
										bytes: stored.entry.kind === 'page' ? stored.entry.html.length : 0
									}
								: {
										domain: 'server',
										name: 'server.freeze',
										op: 'skip',
										url: path,
										reason: freeze_obs!.disqualified_by ?? 'response-ineligible'
									}
						);
					}
					if (stored) {
						return stored.entry.kind === 'page' && stored.entry.stitch
							? await this.#serve_stitched(stored.entry, 'stored', event)
							: stored.response;
					}
					// Refused → per-request forever (until inputs change). Stamp `no-store` when the
					// app set nothing: the verdict's word replaces blanket CDN rules in BOTH directions
					// (a personal page must never be edge-cached by a property-wide TTL).
					stamp_no_store(response);
				} catch {
					freeze_settle({ stored: null });
				}
			} else if (dev && freeze_obs && freeze_page_request) {
				dev_freeze_note(response, path, bag, freeze_obs);
			}
			// Stream captured `$page.data` promises into islands (csr=false, real browser load). The doc
			// — with the pending seed + resolve-global bootstrap — is fully built now (transformPageChunk
			// ran synchronously inside `resolve`); the tail streams a resolve script per promise as it
			// settles. Only set when the request could consume a stream (see `inject_client_seeds`).
			if (bag.deferred && bag.deferred.length) {
				return this.stream_page_deferred(
					response,
					bag.deferred,
					bag.defer_next_id,
					bag.seed_reducers ?? undefined
				);
			}
			return response;
		}
		// POST to the endpoint = a BATCH frame stream (client-side navigation, single-flight): render a set
		// of signed region calls and flush each as an out-of-order frame in one response. Exposures
		// queued by flag reads during these renders drain at the request's end too (serverless-safe).
		try {
			if (event.request.method.toUpperCase() === 'POST') return await this.render_batch(event);
			return await this.render_region(event);
		} finally {
			flush_exposures();
		}
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
		// Kit hands one chunk at a time (ONE chunk for a non-streamed page). Two facts about a chunk
		// decide everything below, each found with one bounded scan (server/document-assembly.ts):
		// `</head>` from the front, `</body>` from the back. The chunk is assembled ONCE at the end.
		const t_start = performance.now();
		const spans = locate(html);
		const head = spans.head_end === -1 ? null : html.slice(0, spans.head_end);

		// csr=true page — Kit serializes its own remotes and hydrates the whole tree; skip seeds. A
		// build-time ROUTE FACT (context.ts, the PAGE-CSR invariant), never a scan of the document;
		// the bounded string probe covers only a routeless response (`route.id` null), where Kit's
		// boot sits in the last bytes before `</body>`. An ERROR RENDER reads the error twin of the
		// map: Kit renders `+error.svelte` from the layout branch alone (the page's `csr = false` is
		// dropped), and the regions recorded Kit's `page.error` into the bag as they rendered — the
		// same fact Region.svelte decided its own inline/island form on, so the two cannot disagree.
		const csr_page =
			event?.route?.id != null
				? bag?.page?.error != null
					? error_route_is_csr_true(event.route.id)
					: route_is_csr_true(event.route.id)
				: spans.body_end !== -1 && html_has_kit_bootstrap(html, spans.body_end);
		if (csr_page) {
			let head_inject = '';
			if (head !== null) {
				// Stamp the fact for the runtime (it boots here only for the regions inside lakes, and
				// reads this meta instead of scanning inline scripts for Kit's bootstrap).
				head_inject = CSR_META;
				// The ogygia runtime never mounts the devtools dock here (Kit owns the page). When
				// devtools is compiled in (`devtools_boot_url` is non-empty only then, dev-only), inject a
				// standalone dock boot so the launcher is on EVERY dev page — on this csr=true page it
				// renders a "csr=true — open a csr=false page" notice, since there are no islands here.
				if (devtools_boot_url && !head.includes('data-ogygia-devtools-boot')) {
					head_inject += `<script type="module" data-ogygia-devtools-boot src="${devtools_boot_url}"></script>`;
				}
			}
			// THE TAIL STILL SHIPS. The regions INSIDE A LAKE are ogygia's on this page too (their real
			// `<ogygia-region>` is emitted, the runtime boots for them), and like on any page their props
			// sidecars and preload hints were deferred into the document tail — so the tail goes out
			// before `</body>` here as well, or an island inside a lake hydrates with `undefined`
			// props and dies (a footer's subscription form did). Rendered against NO seed: the page /
			// remote / context seeds stay off a csr=true page — Kit hydrates the tree and serializes
			// its own remotes — and a sidecar written without a seed carries its values whole.
			const tail = spans.body_end !== -1 && bag ? bag.tail.render(null) : '';
			if (head === null && !tail) return html;
			// The runtime an island inside a lake emitted goes first in `<head>` here too (see the
			// csr=false path below): its regions keep their server markup from the first connect.
			const ordered = head === null ? null : runtime_first(head, null);
			return assemble(html, spans, ordered === head ? null : ordered, head_inject, tail);
		}

		// ── HEAD (the chunk carrying `</head>`) ──
		// Router (global, opt out with `ogygia({ router: false })`). The handle owns the runtime
		// bootstrap + the `ogygia-router` meta the client router reads per-navigation, so no
		// `<Router/>` component is needed. Every injection is presence-checked, so it composes with
		// what a page already emits:
		//  • an island page already carries `data-ogygia-runtime` (Region emits it) → we skip it, and
		//    only load-only pages get the runtime injected here;
		//  • a page can override view transitions per-route by emitting its own
		//    `<meta name="ogygia-router" content="plain">` — present → we leave it, so the page wins.
		// The runtime URL is base-resolved below via Kit's `asset()` — the same authority Region uses for
		// island pages — so an island-less page under a non-root `base` (or an assets CDN) loads it too.
		//
		// Every presence check matches a REAL element, not the tag's name as TEXT — a page that
		// DOCUMENTS one of these tags in a code block (the changelog does) renders it escaped, which a
		// bare `html.includes('name="ogygia-router"')` false-matches, suppressing the injection. See
		// `head-presence.ts` for why that dropped documented pages to full-page navigation.
		// Every check and the link dedupe run on the HEAD SLICE only: that is where the hints, the
		// sheets and the tags they look for live, so the body is never scanned.
		let head_out: string | null = null;
		let head_inject = '';
		if (head !== null) {
			// Dedupe the region-emitted modulepreload hints (each island instance emits its own dep
			// block, so shared deps repeat) and the stylesheet links (a layout's real-wrapper island is
			// linked by Kit from the client graph AND by Region.svelte from the render — 16 doubled
			// sheets on one measured page). Same href → one tag; first occurrence wins.
			const deduped = dedupe_head_links(head);
			if (deduped !== head) head_out = deduped;
			const probe = head_out ?? head;
			// MPA mode (`router: false`): no SPA machinery ships — the browser owns navigation, so the
			// handle injects static Speculation Rules instead. Chromium prerenders likely next pages,
			// Firefox prefetches them, everything else ignores the JSON. Presence-checked so a page
			// authoring its own rules wins; per-link opt-out via `data-ogygia-speculate="off"`.
			if (!router_enabled && mpa_speculation_rules && !page_declares_speculation_rules(probe)) {
				head_inject += `<script type="speculationrules" data-ogygia-speculate>${mpa_speculation_rules}</script>`;
			}
			if (router_enabled && !page_declares_router_meta(probe)) {
				head_inject += `<meta name="ogygia-router" content="${router_view_transitions ? 'vt' : 'plain'}">`;
			}
			// The runtime bootstrap goes FIRST in `<head>` (head-presence.ts `runtime_first`): the one
			// an island page emitted moves up from Kit's head slot, and an island-less page gets it
			// injected there (router on). Base-resolved the same way Region does — `asset()` is the
			// sole base/assets authority, and every ogygia URL (prod `/${appDir}/…`, dev `/@id/…`) is
			// baked base-LESS — so an island-LESS page under a non-root `base` loads the runtime too.
			const runtime_tag =
				router_enabled && runtime_url && !page_declares_runtime_script(probe)
					? `<script type="module" data-ogygia-runtime src="${asset(runtime_url)}"></script>`
					: null;
			const ordered = runtime_first(probe, runtime_tag);
			if (ordered !== probe) head_out = ordered;
			// The DEV bridge is NOT gated on the router — it carries `@vite/client`, and Vite's own
			// full-reload recovery must reach EVERY csr=false page. A dep re-optimization rotates the
			// optimizer's browserHash, so a tab loaded under the old hash dynamic-imports island deps
			// (`svelte.js?v=<old>`) that now 404, and every island fails on wake. Kit ships no client
			// bootstrap under csr=false, so nothing else injects the Vite client; gated on the router,
			// an app with `ogygia({ router: false })` (or any island page whose head the router branch
			// skips) kept a poisoned tab after a re-optimize until a manual reload, reporting only
			// "hydration failed". `dev_hmr_url` is empty outside `vite serve`, so this stays dev-only.
			if (dev_hmr_url && !page_declares_dev_hmr_script(probe)) {
				head_inject += `<script type="module" data-ogygia-dev-hmr src="${asset(dev_hmr_url)}"></script>`;
				// The page's sub-app scope (its route id's first segment) for the dev CSS bridge:
				// a changed stylesheet joins this page only when the plugin derives the same scope
				// among its owners — two route-group sub-apps never paint each other in dev.
				const scope = (event?.route.id ?? '').split('/').filter(Boolean)[0] ?? '';
				head_inject += `<meta name="ogygia-dev-scope" content="${scope.replace(DOUBLE_QUOTE_G, '')}">`;
			}
		}

		// ── BODY (the chunk carrying `</body>`) ──
		// Body-level seeds (page / remote / setContext) go in the FINAL chunk only. Under a streamed
		// render the early chunks have no `</body>` AND no rendered island yet — so the captured page
		// data (Region records it during the island render) isn't ready. Gating here means the seed is
		// built once, after the render, with the real `data`.
		if (spans.body_end === -1) return assemble(html, spans, head_out, head_inject, '');

		// A page on which NO region rendered has no island to feed: no tail, no seed, no remote seed,
		// no fn manifest, no context bridge — it pays nothing below. `bag.page` is recorded by every
		// Region render (islands, holes, lakes, held regions alike), so it is the one fact to read.
		const rendered = !!bag && bag.page !== null;
		const scripts: string[] = [];
		if (!rendered) {
			this.append_devtools_seed(scripts, bag);
			return assemble(html, spans, head_out, head_inject, scripts.join(''));
		}

		// Single page seed (PAGE-DUP) — islands read it through the `$app/state` shim. url/params/route
		// come from the RequestEvent (reading `$app/state`'s `page` in a hook throws
		// `lifecycle_outside_component`). data/form/error/status come from the page snapshot
		// Region.svelte records during SSR from Kit's REAL page — the only place the resolved load data
		// is reachable (Kit merges it locally in render.js, never on RequestState). PAGE-SEED-EVENT.
		const page_snap = bag!.page!;
		// SEED ONLY WHEN READ (the rule is spelled out at the seed payload below): no reader → no
		// seed → the sidecars serialize self-contained, and nothing below stages or settles.
		const seed_wanted = bag!.seed_wanted;
		// THE DOCUMENT TAIL (server/document-tail.ts): the regions' module-preload hints, then their
		// props sidecars — after the content, before the seeds. Rendered ONCE, now that the request
		// knows whether the seed ships: only then does a sidecar serialize relative to it (seed-refs.ts)
		// — every island's, whichever rendered first. The index is over the FULL `page.data`, whatever
		// shaping keeps below: a reference path is structural (a top-level key, then keys and indices
		// down), shaping keeps top-level keys whole, and staging / settling keep the shape too — so a
		// path into the full tree resolves identically against the shipped seed, provided its key
		// ships. The plan records the keys it referenced (`touched`) for exactly that.
		const detail = request_stats_detailed();
		const tail_html = bag!.tail.render(seed_wanted ? index_seed(page_snap.data) : null, detail);
		// SEED SHAPING: the slice of `page.data` the page's islands read (server/seed-shape.ts) — every
		// step below (streaming, settling, the payload) sees the shaped tree. A key no island's code
		// reads but whose node an island's props point into ships too: a reference must have something
		// to point at. The freeze verdict above read the whole snapshot (a streamed promise anywhere
		// keeps the page per-request).
		let seed_keys = bag!.seed_keys;
		if (seed_wanted && seed_keys !== 'all' && seed_keys !== null) {
			for (const k of index_seed(page_snap.data).touched) seed_keys.add(k);
		}
		const shaped_data = shape_page_data(page_snap.data, seed_keys);
		let seed_data = shaped_data;
		let seed_form = page_snap.form;
		// Merge the app's universal `transport` ENCODERS (custom types the app teaches Kit) with the
		// DeferRef/SettledRef marker reducers, so a load's custom types round-trip into islands — not
		// just built-in devalue types. A no-op for the common promise-free / transport-free seed.
		const transport_encoders = Object.fromEntries(
			Object.entries(state?.transport ?? {}).map(([name, codec]) => [name, codec.encode])
		);
		const seed_reducers = { ...transport_encoders, ...page_seed_reducers };
		const seed_stringify = ((v: unknown) => stringify(v, seed_reducers)) as typeof stringify;
		// ONE walk of the seed tree (seed-refs.ts `analyze`, against the request's shared memo — the
		// tail's index above already measured every node; a shaped root is a few lookups) answers
		// every question below: a streamed promise inside (stage or settle), JSON-exact (the native
		// lane).
		const data_shape = analyze(shaped_data);
		const form_shape = analyze(page_snap.form ?? null);
		// A load may return promises at any level (Kit streaming). csr=false can't hydrate the PAGE, so
		// Kit's own resolve stream is dead there — but an ISLAND has a client. Two paths:
		//  • Real browser load (`Sec-Fetch-Mode: navigate`) can consume a stream — STAGE each promise to a
		//    marker (a pending Promise on the client) and stream a resolve `<script>` per settle after the
		//    doc ships (`stream_page_deferred`, drains Kit's dead tail). Inline bootstrap defines the
		//    resolve global before any resolve script runs.
		//  • Programmatic fetch (SPA/router, mode ≠ navigate) can't run streamed scripts, so SETTLE the
		//    promises here and seed resolved values — no hang, same as before.
		const has_pending = data_shape.thenable || form_shape.thenable;
		// FREEZE: a page with streaming promises is per-request BY INTENT — even on the
		// non-navigate path where the promises get settled into a complete document (storing
		// that copy would freeze one settle forever while browser loads stream live).
		if (has_pending && bag!.freeze_obs && bag!.freeze_obs.disqualified_by === null) {
			bag!.freeze_obs.disqualified_by = 'streamed load (promise in page data)';
		}
		const can_stream = event?.request.headers.get('sec-fetch-mode') === 'navigate';
		// No reader → no seed → nothing to stage or settle (the freeze verdict above still saw the
		// promise: that page stays per-request).
		if (has_pending && can_stream && seed_wanted) {
			const staged_data = stage_deferred(shaped_data, 0);
			const staged_form = stage_deferred(page_snap.form, staged_data.next_id);
			seed_data = staged_data.staged;
			seed_form = staged_form.staged;
			bag!.deferred = [...staged_data.deferred, ...staged_form.deferred];
			bag!.defer_next_id = staged_form.next_id; // real next id — do NOT recompute from array length
			bag!.seed_reducers = seed_reducers; // resolve scripts encode with the same transport + defer
			scripts.push(`<script>${PAGE_DEFER_BOOTSTRAP}</script>`);
		} else if (has_pending && seed_wanted) {
			seed_data = await settle_deferred(shaped_data);
			seed_form = await settle_deferred(page_snap.form);
		}

		// The tail (rendered above, before shaping) goes out after the defer bootstrap, before the seeds.
		if (tail_html) scripts.push(tail_html);

		// SEED ONLY WHEN READ: the seed exists so islands can read `$page` through the shim. A region
		// asks for it (`seed_wanted`) only when its client code reaches the `$app/state` / `$app/stores`
		// shim (`islandReadsPage`, from the build's chunk closure; fail-open for an entry the handoff
		// does not know, e.g. a foreign fragment's island). No reader → no seed: a CMS page whose 20
		// islands take everything as props stops shipping its whole `page.data` again (674 KB on one
		// measured page) and stops serializing it on the server.
		// THE LANE: a JSON-exact slice (the common CMS tree, no promise staged into it) goes out as
		// native `JSON.stringify` output; anything devalue exists for keeps devalue.
		let remote_seed_bytes = 0;
		let fnm_bytes = 0;
		let ctx_bytes = 0;
		const page_payload =
			event && seed_wanted
				? PageSeed.serialize(
						{
							url: event.url,
							params: event.params,
							route: event.route,
							status: page_snap.status ?? 200,
							data: seed_data,
							form: seed_form,
							error: page_snap.error
						},
						seed_stringify,
						!has_pending &&
							data_shape.json &&
							form_shape.json &&
							analyze(page_snap.error ?? null).json
					)
				: null;
		if (page_payload) {
			scripts.push(
				emit_ogygia_script(
					'page',
					page_payload.text,
					'data-ogygia-page' +
						(page_payload.json ? ` ${WIRE_FORMAT_ATTR}="${WIRE_FORMAT_JSON}"` : '')
				)
			);
			if (DEVTOOLS)
				record_server_event({
					domain: 'server',
					name: 'server.seed.injected',
					kind: 'page',
					bytes: page_payload.text.length
				});
		}

		if (state?.remote?.implicit) {
			const remote_script = await this.build_remote_seed_script(state, bag!.remotes_wanted);
			if (remote_script) {
				scripts.push(remote_script);
				remote_seed_bytes = remote_script.length;
				if (DEVTOOLS)
					record_server_event({
						domain: 'server',
						name: 'server.seed.injected',
						kind: 'remote',
						bytes: remote_script.length
					});
			}
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
			const fnm_script = `<script data-ogygia-fnm>globalThis.__OG_FNM=Object.assign(globalThis.__OG_FNM||{},{${entries}});</script>`;
			scripts.push(fnm_script);
			fnm_bytes = fnm_script.length;
		}

		// Drop-in `setContext` page root — emitted here (final chunk) so every `setContext` has run.
		const provided = bag?.ctx;
		if (provided?.size) {
			// Drops any non-serializable value (function / store / class instance) instead of crashing.
			const payload = serialize_provided_context(provided);
			if (payload) {
				scripts.push(emit_ogygia_script('ctx', payload, PAGE_CTX_MARKER));
				ctx_bytes = payload.length;
			}
		}

		this.append_devtools_seed(scripts, bag);
		// ONE assembly from slices — no `replace` (whose `$$` escape would also corrupt an og.$ factory
		// source carrying a literal `$`), no intermediate copies of the body.
		const out = assemble(html, spans, head_out, head_inject, scripts.join(''));
		// OGYGIA'S OWN COST, for the profiler's request log (server/request-stats.ts): what this
		// transform took and what it added. One WeakMap write; nothing when no profiler reads it.
		if (event) {
			const size = bag!.tail.size;
			record_request_stats(event.request, {
				transform_ms: Math.round((performance.now() - t_start) * 100) / 100,
				islands: size.props,
				hints: size.hints,
				holes: size.holes,
				seed_bytes: page_payload ? page_payload.text.length : 0,
				remote_seed_bytes,
				tail_bytes: tail_html.length,
				fnm_bytes,
				ctx_bytes,
				seed_json: page_payload?.json ?? false,
				// DETAIL (the profiler is recording): the per-island rows, the seed explainer, the
				// holes. The seed explainer reads the request's shared measure memo — a lookup per key.
				...(detail
					? {
							seed_culprit:
								page_payload && !page_payload.json ? json_culprit(seed_data) : null,
							island_rows: bag!.tail.island_rows() ?? [],
							seed: this.explain_seed(page_snap.data, seed_keys, bag!),
							hole_rows: bag!.tail.hole_rows()
						}
					: {})
			});
		}
		return out;
	}

	/**
	 * THE SEED EXPLAINER: per top-level `page.data` key, its size and why it ships — an island's
	 * client code reads it (the build's per-entry keys), a sidecar points into it (seed refs), or
	 * some island reads the page whole and everything ships. Profiler detail only.
	 */
	explain_seed(
		data: unknown,
		seed_keys: import('./server/seed-shape.js').SeedKeys | null,
		bag: RequestBag
	): { keys: SeedKeyStat[]; whole_by: string[] } {
		// islands by their component name (the tail's rows carry it); an entry no row names keeps
		// its entry (a dev module URL / a built facade) — each named once
		const rows = bag.tail.island_rows() ?? [];
		const names = new Map<string, string>();
		for (const row of rows) if (row.name && !names.has(row.entry)) names.set(row.entry, row.name);
		const name_of = (entry: string) => names.get(entry) ?? entry;
		const add = (m: Map<string, Set<string>>, k: string, v: string) => (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
		const whole = new Set<string>();
		const readers = new Map<string, Set<string>>();
		for (const [entry, ask] of bag.seed_asks ?? []) {
			if (ask === 'all') whole.add(name_of(entry));
			else if (ask !== false) for (const k of ask) add(readers, k, name_of(entry));
		}
		const referenced = new Map<string, Set<string>>();
		for (const row of rows) for (const k of row.ref_keys) add(referenced, k, name_of(row.entry));
		const whole_by = [...whole];
		const keys: SeedKeyStat[] = [];
		if (data && typeof data === 'object' && !Array.isArray(data)) {
			for (const key of Object.keys(data as Record<string, unknown>)) {
				const shipped = seed_keys === 'all' || (seed_keys !== null && seed_keys.has(key));
				const read = [...(readers.get(key) ?? [])];
				const refd = [...(referenced.get(key) ?? [])];
				keys.push({
					key,
					bytes: analyze((data as Record<string, unknown>)[key]).bytes,
					readers: read,
					referenced_by: refd,
					shipped,
					reason: !shipped ? null : read.length ? 'read' : refd.length ? 'referenced' : whole_by.length ? 'whole' : 'read'
				});
			}
		}
		keys.sort((a, b) => b.bytes - a.bytes);
		return { keys, whole_by };
	}

	/** DEVTOOLS: drain this request's server-realm events (region renders, capability mints, seeds)
	 *  into an `application/ogygia-devtools` side-channel the client bus ingests — one stream, both
	 *  realms, correlated by fingerprint. Appended LAST so the seed.injected events are included. */
	append_devtools_seed(scripts: string[], bag: RequestBag | undefined): void {
		const dt_buf = DEVTOOLS && bag ? dt_buffers.get(bag) : undefined;
		if (DEVTOOLS && dt_buf && dt_buf.events.length) {
			scripts.push(
				emit_ogygia_script('devtools', escape_script_text(JSON.stringify(dt_buf.events)))
			);
		}
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
				//    its (dead) resolve scripts only AFTER this, as separate chunks. Carry the last six
				//    decoded characters across reads so a `</body>` split over a chunk boundary is still
				//    detected — never the whole document (a second 2.6 MB copy, rescanned per chunk).
				let carry = '';
				try {
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						controller.enqueue(value);
						const probe = carry + decoder.decode(value, { stream: true });
						if (probe.includes('</body>')) break;
						carry = probe.slice(-6);
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
						controller.enqueue(
							encoder.encode(resolve_script(PAGE_DEFER_GLOBAL, id, { ok, value }, reducers))
						);
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
		return new Response(stream, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
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

	async build_remote_seed_script(
		state: RequestState,
		/** REMOTE SEED ONLY WHEN REACHABLE: the id-hashes some region's client on this page can call
		 *  (`bag.remotes_wanted`); `null` = unknown → seed every implicit remote (the pre-gate rule). */
		wanted: ReadonlySet<string> | null = null
	): Promise<string | null> {
		const implicit = state.remote?.implicit;
		if (!implicit) return null;

		// The bucketing (Kit parity: q / p / l / f, `create_remote_key` keys) and the skips — private
		// remote, no region's client can call it (`wanted`), errored/pending, baked-region value —
		// live in server/remote-seed-gate.ts, pure and unit-tested; this serializes what comes back.
		const data = await collect_remote_seed(implicit, wanted, {
			memo: (internals) => state.remote.data?.get(internals as never),
			skip_value: (v) => this.has_baked_region(v),
			key: create_remote_key
		});

		if (!Object.values(data).some((b) => Object.keys(b).length > 0)) return null;

		const transport = state.transport || {};
		const reducers = Object.fromEntries(
			Object.entries(transport).map(([name, codec]) => [name, codec.encode])
		);
		// devalue output is `<`-safe by itself (it writes `<`), so no second pass over the payload.
		return emit_ogygia_script('remote', devalue.stringify(data, reducers));
	}

	/**
	 * `render()` the island under the concurrency gate + timeout. Returns the HTML body, or `null`
	 * if the render threw or timed out. Shared by the endpoint ({@link render_region}) and the
	 * batch path ({@link #render_capability}).
	 */
	async #render_component(
		load: () => Promise<{ default: unknown }>,
		props: Record<string, unknown>,
		cache?: { key: string; ttl: number },
		/** the profiler's hole economics: what the cache did for this request */
		report?: (outcome: 'hit' | 'miss' | 'none') => void
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
						const rendered = render(mod.default as Component<Record<string, unknown>>, {
							props,
							context: kit_render_context()
						});
						return await Promise.race([
							Promise.resolve(rendered).then((out) => out.body as string),
							new Promise<never>((_, rej) =>
								setTimeout(() => rej(new Error('region render timeout')), RENDER_TIMEOUT_MS)
							)
						]);
					}),
				cache,
				Date.now(),
				report
			);
		} catch (e) {
			// `keepFallback()` ends a render on purpose: the page's fallback is right for this
			// visitor. Carried as a marker string so the cache/batch/endpoint seams stay string-typed.
			if (is_keep_fallback(e)) return KEEP_FALLBACK_HTML;
			// The response is an opaque 500 ("Region render failed"); the reason belongs in the dev
			// terminal — a hole that throws only on the dev server is otherwise a blind hunt.
			if (import.meta.env.DEV) console.warn('[ogygia] region render failed:', e);
			return null;
		}
	}

	/** The session cookie value sealed into a region capability (empty when no `sessionCookie` is
	 *  configured) — the same read the MAC verify uses, and the per-user part of the render-cache key. */
	#region_session(event: RequestEvent): string {
		return session_cookie ? (event.cookies.get(session_cookie) ?? '') : '';
	}

	/**
	 * FREEZE serve-time stitching: fill every `stitch` hole in the stored shell with a fresh
	 * SERVER render — `#render_capability` verifies the hole's own signed MAC and renders with
	 * THIS request's event, so the visitor's cookies ride in and the splice is personalized in
	 * the first response. FAIL-OPEN per hole (a null render keeps the fallback + client fetch).
	 * hit/join serves still carry the doc marker first, so live regions inside keep
	 * self-freshening.
	 */
	async #serve_stitched(
		entry: Extract<FreezeEntry, { kind: 'page' }>,
		via: 'hit' | 'join' | 'stored',
		event: RequestEvent
	): Promise<Response> {
		const html = await stitch_html(served_html(entry, via), async (endpoint) => {
			const out = await this.#render_capability(endpoint, event);
			// a "keep the fallback" answer keeps the stored fallback in place (same as fail-open)
			return out && out.html !== KEEP_FALLBACK_HTML ? out.html : null;
		});
		return new Response(html, {
			status: 200,
			headers: { ...entry.headers, 'x-ogygia-freeze': via }
		});
	}

	// ── Shared capability core ──────────────────────────────────────────────────────────────────
	// The endpoint ({@link render_region}) and the batch path ({@link #render_capability}) MUST verify
	// identically — a one-sided change to the MAC message or the props reviver would weaken auth on one
	// path only. The three security-critical steps live here, once. Each caller keeps its OWN failure
	// shaping (403/500 + rate-limit interleaving vs null→client-fetch), which is where they legitimately
	// differ; only the trust decisions are shared.

	/** Charset/length/expiry gate — cheap, runs BEFORE any HMAC (P5-HMAC-CPU). */
	#capability_gate_ok(id: string, payload: string, ttl_raw: string, exp_raw: string): boolean {
		if (
			!REGION_ID_RE.test(id) ||
			payload.length > MAX_REGION_PROPS_LEN ||
			!REGION_TTL_RE.test(ttl_raw)
		)
			return false;
		const exp = Number(exp_raw);
		return Number.isFinite(exp) && exp >= Math.floor(Date.now() / 1000);
	}

	/** THE auth check: session-bound region MAC verify. */
	#verify_region_mac(
		id: string,
		payload: string,
		exp_raw: string,
		ttl_raw: string,
		sig: string,
		event: RequestEvent
	): boolean {
		// The capability seals the session cookie (if any) into the signed message.
		const session = session_cookie ? (event.cookies.get(session_cookie) ?? '') : '';
		return verify(secret, region_mac_message(id, exp_raw, payload, session, ttl_raw), sig);
	}

	/** Eval the island module (registers transportable codecs the reviver needs on a cold-start defer),
	 *  then decode + revive the props payload. Null on parse failure or a non-object/array result. */
	async #decode_region_props(
		payload: string,
		load: () => Promise<unknown>
	): Promise<Record<string, unknown> | null> {
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
				[REF_WIRE_KEY]: ref_reviver(false)
			} as Parameters<typeof devalue.parse>[1]);
		} catch (e) {
			if (import.meta.env.DEV)
				console.warn('[ogygia] region endpoint 403: island module load / props decode failed', e);
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
		// "Keep the fallback": the parcel carries the marker alone (no CSS links, nothing to hoist).
		if (body === KEEP_FALLBACK_HTML) return { slot: sig, html: KEEP_FALLBACK_HTML };
		// CSS links ride in the parcel; the client hoists them to <head> (a body/parcel link is inert
		// inside the `<template>` box), so a batched server-island still styles a page that never
		// imported its component. URLs inside are made root-absolute: `asset()` made them relative
		// to THIS request, and the parcel lands in a page at any depth (server/hole-urls.ts).
		return { slot: sig, html: absolutize_hole_html(region_css_links(id) + body, event.url) };
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
			// Server-side only (the response stays an opaque 403 — SEC-01): a dev seeing every hole
			// fail deserves the reason in the terminal.
			if (import.meta.env.DEV)
				console.warn(`[ogygia] region endpoint 403: bad signature for id "${id}"`);
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
			if (import.meta.env.DEV)
				console.warn(
					`[ogygia] region endpoint 403: id "${id}" is not in the server manifest (${Object.keys(island_modules).length} known)`
				);
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
		const body = await this.#render_component(load, props, cache, (outcome) =>
			record_hole_stats(event.request, { kind: 'hole', id, cache: outcome, ttl })
		);
		if (body === null) {
			return region_response('Region render failed', { status: 500 });
		}
		// `keepFallback()`: no content — the runtime keeps the page's fallback and marks the hole done.
		if (body === KEEP_FALLBACK_HTML) return region_response(null, { status: 204 });

		if (body.length > MAX_REGION_BODY) {
			return region_response('Forbidden', { status: 403 });
		}

		// Ship the component's stylesheet links ahead of its HTML (the client hoists them to <head>).
		// Root-absolute URLs inside: the hole's HTML is spliced into a page at any depth — by the
		// runtime, or by a CDN (ESI) — where a `./_app/…` entry would 404 (server/hole-urls.ts).
		const html = absolutize_hole_html(region_css_links(id) + body, event.url);

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
// `document()` — render a held region into a complete ogygia document (a `Response`). Server-only.
export { document, type DocumentOptions } from './document.js';
// The region round-trip for an app that runs a third-party SSR/hydration pass over the document and
// must not reshape island bytes: `scanRegions()` walks the `<ogygia-region>` subtrees;
// `liftRegions()` / `restoreRegions()` take them out and splice them back (marks merged). Also on
// the Kit-free `ogygia/rewrite` export, for the non-SvelteKit half of a monorepo.
export {
	scanRegions,
	liftRegions,
	restoreRegions,
	type RegionSpan,
	type RegionKind,
	type LiftedRegion,
	type LiftResult
} from './server/split-regions.js';

export function handle(options: OgygiaHandleOptions = {}): Handle {
	const instance = new OgygiaHandle(options);
	return (args) => instance.handle(args);
}
