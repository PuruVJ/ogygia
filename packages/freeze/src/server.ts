/**
 * The freeze plugin's server half (imported by the build through `virtual:ogygia/server-plugins`,
 * with the `freeze({ ttl, default })` options).
 *
 * `page`: the read path. A GET, no query string, not prerendering, on a route that opts in: a stored
 * copy answers — Kit, loads and Svelte never run. A concurrent cold miss JOINS the in-flight render
 * (the stampede law: N concurrent requests, ONE render). The first cold request opens the flight,
 * marks the render `facts.storable` (its holes mint prerender-grade, its data-source receipts are
 * kept) and observes it for personalization.
 *
 * `response`: the write path. The verdict (nothing personal read, nothing streamed, a cacheable
 * 200 or permanent redirect) stores the page and sends the stored copy; a refusal stamps
 * `private, no-store` when the app set nothing. A successful mutation self-evicts its page.
 *
 * In dev nothing is stored or served — HMR truth beats byte reuse — but the verdict still runs and
 * teaches: an eligible page gets `x-ogygia-freeze: would-store`, a refused one a console note.
 */
import { createHash } from 'node:crypto';
import { building, dev } from '$app/env';
import {
	defineServer,
	STORED_DOCUMENT_META,
	type RequestContext,
	type ServerPlugin
} from '@ogygia/core/plugin';
import {
	begin_flight,
	current_edges,
	current_store,
	freeze_get,
	freeze_put,
	invalidate_tags,
	join_flight,
	self_evict,
	type FlightOutcome
} from './registry.ts';
import { observe_event, type Observation } from './observe.ts';
import { esi_rewrite, stitch_html, stitch_modes } from './stitch.ts';
import { set_freeze_app } from './app.ts';
import type { FreezeEntry } from './types.ts';

/** The plugin's serializable policy (`freeze({ ttl, default })`, normalized by the factory). */
export interface FreezeServerOptions {
	/** TTL backstop, seconds (clamped to [1, 86400]). */
	ttl: number;
	/** The app-wide opt-in: true = every eligible page (a route opts OUT with `export const freeze
	 *  = false`); false = nothing unless a route opts IN. */
	default: boolean;
}

interface State {
	/** settles the stampede flight this request opened (null when it opened none) */
	settle: ((outcome: FlightOutcome) => void) | null;
	/** the personalization observation (eligible requests only) */
	obs: Observation | null;
	/** the request was eligible to be stored */
	eligible: boolean;
}

type Ctx = RequestContext<FreezeServerOptions, State>;

/** Kit's boot declares its deferred map ONLY on pages with pending (streamed) load promises —
 *  verified against @sveltejs/kit 2.70 (render.js: `blocks.push('const deferred = new Map();')`). */
const KIT_DEFERRED_BOOT_RE = /const deferred = new Map\(\);/;

/** The build marker key in the store (NUL-prefixed: no page path can collide with it). */
const BUILD_MARKER_KEY = '\0og:build';

/** Rebuild a Response from a stored page. `via` rides a debug header the harness asserts on.
 *  With the incoming `request`, a matching validator answers 304 — plain-HTTP conditional
 *  requests (RFC 9110), which is what makes a CDN or browser revalidation of a stored page cost
 *  zero body bytes. Validators live on the ENTRY, never in edge adapters: they are the render's
 *  identity, not a CDN dialect. */
export function freeze_response(
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
	return at === -1
		? entry.html
		: entry.html.slice(0, at) + STORED_DOCUMENT_META + entry.html.slice(at);
}

/** Serve-time stitching: fill every `stitch` hole in the stored shell with a fresh SERVER render
 *  (`ctx.renderHole` verifies the hole's own signed MAC and renders with THIS request's event, so
 *  the visitor's cookies ride in and the splice is personalized in the first response). FAIL-OPEN
 *  per hole (a null render keeps the fallback + client fetch). hit/join serves still carry the doc
 *  marker first, so live regions inside keep self-freshening. */
async function serve_stitched(
	entry: Extract<FreezeEntry, { kind: 'page' }>,
	via: 'hit' | 'join' | 'stored',
	ctx: Ctx
): Promise<Response> {
	const html = await stitch_html(served_html(entry, via), (endpoint) => ctx.renderHole(endpoint));
	return new Response(html, {
		status: 200,
		headers: { ...entry.headers, 'x-ogygia-freeze': via }
	});
}

function serve(entry: FreezeEntry, via: 'hit' | 'join', ctx: Ctx): Promise<Response> | Response {
	return entry.kind === 'page' && entry.stitch
		? serve_stitched(entry, via, ctx)
		: freeze_response(entry, via, ctx.event.request);
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
function dev_freeze_note(response: Response, ctx: Ctx, obs: Observation): void {
	const refusal =
		obs.disqualified_by ??
		(obs.wrote_cookie ? 'a cookie write' : null) ??
		(response.status !== 200 ? `status ${response.status}` : null) ??
		(response.headers.has('set-cookie') ? 'a set-cookie response header' : null) ??
		(!(response.headers.get('content-type') ?? '').includes('text/html')
			? 'a non-html response'
			: null) ??
		(ctx.facts.streamed ? 'streamed load promises' : null);
	if (!refusal) {
		try {
			response.headers.set('x-ogygia-freeze', 'would-store');
		} catch {
			/* immutable headers */
		}
		return;
	}
	if (dev_noted_paths.has(ctx.path)) return;
	dev_noted_paths.add(ctx.path);
	console.warn(
		`[ogygia] freeze: ${ctx.path} stays per-request — the render read ${refusal}. ` +
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
	ctx: Ctx,
	obs: Observation,
	ttl: number
): Promise<{ entry: FreezeEntry; response: Response } | null> {
	const { path, facts } = ctx;
	const tags = facts.sources ?? [];
	// Personalization observed (cookie/header/locals/flag read, or a cookie write) → per-request.
	if (obs.disqualified_by || obs.wrote_cookie) return null;
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
		await freeze_put(path, entry, { ttl, tags });
		return { entry, response };
	}
	if (response.status !== 200) return null;
	if (response.headers.has('set-cookie')) return null;
	const content_type = response.headers.get('content-type') ?? '';
	if (!content_type.includes('text/html')) return null;
	const app_cc = response.headers.get('cache-control') ?? '';
	if (app_cc.includes('private') || app_cc.includes('no-store')) return null;
	if (facts.streamed) return null; // streamed page — always per-request
	const html = await response.text();
	// Belt and braces for streamed pages WITHOUT regions (no page snapshot to probe): Kit's boot
	// only declares its deferred-map when the page carries pending promises — buffering such a
	// response bakes ONE settle's inline resolve scripts into the copy. Never store it.
	if (KIT_DEFERRED_BOOT_RE.test(html)) return null;
	const created = Date.now();
	// STITCH holes, two modes (stitch.ts):
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
	// time — every later revalidation (CDN prefresh, browser reload) can answer 304.
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
	await freeze_put(path, entry, { ttl, tags });
	return { entry, response: freeze_response(entry, 'stored') };
}

const server: ServerPlugin<FreezeServerOptions, State> = defineServer<FreezeServerOptions, State>({
	setup(app) {
		set_freeze_app(app);
	},

	state: () => ({ settle: null, obs: null, eligible: false }),

	async page(ctx) {
		const { event, path, facts, state } = ctx;
		const eligible =
			!facts.private &&
			!building &&
			event.request.method.toUpperCase() === 'GET' &&
			event.url.search === '' &&
			!path.endsWith('__data.json') &&
			!facts.answerForm &&
			(ctx.routeOption('freeze') ?? ctx.options.default) === true;
		if (!eligible) return;
		state.eligible = true;
		if (dev) {
			// observe only: the verdict teaches in `response`, nothing stores
			state.obs = observe_event(event, facts);
			return;
		}
		const hit = await freeze_get(path);
		if (hit) {
			ctx.app.devtools({ domain: 'server', name: 'server.freeze', op: 'hit', url: path });
			return serve(hit, 'hit', ctx);
		}
		const flight = join_flight(path);
		if (flight) {
			const outcome = await flight;
			if (outcome.stored) {
				ctx.app.devtools({ domain: 'server', name: 'server.freeze', op: 'join', url: path });
				return serve(outcome.stored, 'join', ctx);
			}
			// The flight proved the page ineligible — render per-request, no new flight
			// (a chain of flights would serialize renders of a page that never stores).
			return;
		}
		// First cold request: open the flight + observe the render for the verdict.
		state.settle = begin_flight(path);
		state.obs = observe_event(event, facts);
		facts.storable = true;
		facts.sources ??= []; // keep the render's data-source receipts: the page's reverse index
	},

	async response(ctx, response) {
		const { event, path, state } = ctx;
		// Action self-evict — a successful mutation on a page URL evicts its stored copy (mirrors
		// Kit's actions-invalidate-loads semantics; origin store only, fire-and-forget).
		if (event.request.method.toUpperCase() !== 'GET' && response.status < 400) self_evict(path);
		const { settle, obs } = state;
		if (settle && obs) {
			// A failed flight ALWAYS settles (joiners in the stampede must never hang), and a store
			// problem never fails the request.
			try {
				const stored = await capture_freeze(response, ctx, obs, ctx.options.ttl);
				settle({ stored: stored?.entry ?? null });
				ctx.app.devtools(
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
								reason: obs.disqualified_by ?? 'response-ineligible'
							}
				);
				if (stored) {
					return stored.entry.kind === 'page' && stored.entry.stitch
						? await serve_stitched(stored.entry, 'stored', ctx)
						: stored.response;
				}
				// Refused → per-request forever (until inputs change). Stamp `no-store` when the app set
				// nothing: the verdict's word replaces blanket CDN rules in BOTH directions (a personal
				// page must never be edge-cached by a property-wide TTL).
				stamp_no_store(response);
			} catch {
				settle({ stored: null });
			}
		} else if (dev && obs && state.eligible) {
			dev_freeze_note(response, ctx, obs);
		}
	},

	// SHARED HOOK — a peer said these tags are stale (federation's inbound thaw): drop the pages.
	// Never re-announced.
	async invalidate(tags) {
		await invalidate_tags(tags);
	},

	// SHARED HOOK — deploy thaw: remember this build, answer the one the store saw before.
	async lastBuild(version) {
		const store = current_store();
		const marker = await store.get(BUILD_MARKER_KEY);
		const seen = marker?.kind === 'page' ? marker.html : undefined;
		if (seen !== version)
			await store.put(
				BUILD_MARKER_KEY,
				{ kind: 'page', html: version, headers: {}, created: Date.now() },
				{ ttl: 86_400, tags: [] }
			);
		return seen;
	}
});
export default server;
