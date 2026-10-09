/**
 * THE PAGE OF A RENDER — one model for every server render ogygia starts
 * (internal/notes/region-page-context.md).
 *
 * A region always belongs to a page. Which page, and where its facts come from, depends on the
 * request the render runs in — three venues, one answer shape (Kit's `page`):
 *
 *  - IN THE PAGE: a Kit page request. Its render recorded the page (Region.svelte, the routeless
 *    document root): that snapshot IS the page, the live event fills what it lacks.
 *  - FOR A PAGE: a request rendering on behalf of a page it is not — the islands endpoint (a hole, a
 *    batch) or a remote function call (a `query` / `command` rendering a region). Its page is the
 *    same-origin `Referer` (the runtime's and Kit's client fetches send the full URL same-origin).
 *    Identity (url) from there; `page.data`, `params`, `route` from Kit's data request for that page,
 *    looked up once per request and only for a render that reads `page.data` (server/page-facts.ts).
 *  - ITS OWN: anything else (no Referer, cross-origin, an ESI subrequest, a `+server.ts`): the
 *    request's own url, params and route; no `page.data`.
 *
 * Nothing here trusts the browser for data: a Referer only names a page; its facts are the server's,
 * for this visitor, now.
 */
import type { RequestEvent } from '@sveltejs/kit';
import * as devalue from 'devalue';
import type { KitPage } from './kit-context.js';
import type { PageSnapshot } from '../page-seed-registry.js';
import { look_up_page, type PageFacts } from './page-facts.js';
import { merge_seed_ask, shape_page_data, type SeedAsk, type SeedKeys } from './seed-shape.js';
import { PAGE_FACTS_SCRIPT_TYPE } from '../page-facts-script.js';

type Transport = Record<string, { decode: (v: unknown) => unknown; encode: (v: unknown) => unknown }>;

let endpoint_path = '';
let warn: ((message: string) => void) | null = null;

/** The handle's settings: the islands endpoint path it serves, and where a dev warning goes. */
export function configure_render_page(o: { endpoint_path: string; warn: ((message: string) => void) | null }): void {
	endpoint_path = o.endpoint_path;
	warn = o.warn;
}

/** A request rendering on behalf of a page it is not: the islands endpoint or a remote call. */
export function renders_for_a_page(event: RequestEvent): boolean {
	return (endpoint_path !== '' && event.url.pathname.endsWith(endpoint_path)) || (event as { isRemoteRequest?: boolean }).isRemoteRequest === true;
}

/** The page a request renders for: the same-origin Referer of a request rendering for a page, else
 *  the request's own url. */
export function page_url_of(event: RequestEvent): URL {
	if (!renders_for_a_page(event)) return event.url;
	const referer = event.request.headers.get('referer');
	if (!referer) return event.url;
	try {
		const page = new URL(referer);
		if (page.origin === event.url.origin) return page;
	} catch {
		/* malformed referer: the request's own */
	}
	return event.url;
}

const looked_up = new WeakMap<Request, Promise<void>>();
const facts_of = new WeakMap<Request, PageFacts>();

/**
 * Before an async render root starts: in a request rendering FOR a page, that page's facts, looked
 * up once. `reads_data`: does this render read `page.data` (`null`: unknown here — a remote call
 * looks up, a hole relies on its tree's build answer). The venue is the request's kind, as Kit and
 * the islands endpoint name it — never whether some per-request state happens to exist.
 */
export function prepare_render_page(event: RequestEvent | undefined, transport: Transport | undefined, reads_data: boolean | null): Promise<void> | void {
	if (!event || !renders_for_a_page(event)) return;
	if (!(reads_data ?? (event as { isRemoteRequest?: boolean }).isRemoteRequest === true)) return;
	const request = event.request;
	const known = looked_up.get(request);
	if (known) return known;
	const page = page_url_of(event);
	if (page === event.url) return;
	const decoders: Record<string, (v: unknown) => unknown> = {};
	for (const name in transport ?? {}) decoders[name] = transport![name].decode;
	const p = look_up_page(page, event.fetch, decoders).then((facts) => {
		if ('miss' in facts) warn?.(`[ogygia] ${page.pathname}: the page's data for a render outside it is unavailable: ${facts.miss}. The render sees an empty page.data.`);
		else facts_of.set(request, facts);
	});
	looked_up.set(request, p);
	return p;
}

/**
 * The page a render sees. `snapshot`: what this request's page render recorded, if anything. `null`
 * when there is neither a snapshot nor a request (a render off-request: the caller's empty page).
 */
export function render_page(snapshot: PageSnapshot | undefined, event: RequestEvent | undefined): KitPage | null {
	if (!snapshot && !event) return null;
	if (event && renders_for_a_page(event)) {
		// FOR A PAGE: the Referer's page — its looked-up facts, else its url alone
		const facts = facts_of.get(event.request);
		return {
			url: facts?.url ?? page_url_of(event),
			params: facts?.params ?? {},
			route: facts?.route ?? { id: null },
			status: 200,
			data: facts && warn ? watched_data(facts, warn) : (facts?.data ?? {}),
			form: null,
			error: null,
			state: {}
		};
	}
	// IN THE PAGE (its recorded snapshot, the live event filling the rest) or ITS OWN
	const snap: PageSnapshot = snapshot ?? {};
	return {
		url: snap.url?.href ? new URL(snap.url.href) : event?.url,
		params: snap.params ?? event?.params ?? {},
		route: snap.route ?? { id: event?.route.id ?? null },
		status: snap.status ?? 200,
		data: snap.data ?? {},
		form: snap.form ?? null,
		error: snap.error ?? null,
		state: {}
	};
}

/** Reads a component makes without meaning a page key (Svelte, devalue, a thenable check). */
const NOT_A_KEY = new Set(['then', 'toJSON', 'constructor', 'valueOf', 'toString', '$$typeof', 'nodeType']);
const warned_keys = new WeakMap<PageFacts, Set<string>>();

/**
 * DEV: a render for a page reading a `page.data` key the page's server loads did not produce — most
 * often one a UNIVERSAL load (`+page.ts` / `+layout.ts`) makes, which exists only inside a full page
 * render. Said once per key, naming it, instead of rendering `undefined` silently (a header that
 * comes out "signed out" with no error anywhere).
 */
function watched_data(facts: PageFacts, say: (message: string) => void): Record<string, unknown> {
	return new Proxy(facts.data, {
		get(target, key, receiver) {
			if (typeof key === 'string' && !NOT_A_KEY.has(key) && !(key in target)) {
				let seen = warned_keys.get(facts);
				if (!seen) warned_keys.set(facts, (seen = new Set()));
				if (!seen.has(key)) {
					seen.add(key);
					say(
						`[ogygia] ${facts.url.pathname}: a region rendered outside its page read page.data.${key}, which this page's server loads do not produce. ` +
							`A key a universal load (+page.ts / +layout.ts) returns exists only inside a full page render: return it from a server load, or pass it as a prop.`
					);
				}
			}
			return Reflect.get(target, key, receiver);
		}
	});
}

const versions = new WeakMap<Request, string>();

/**
 * A HOLE'S ADDRESS NAMES ITS PAGE: the call (id + props) and the page facts its tree renders from.
 * A region refreshed after the page's data changed (a locale saved) re-mints its holes with a new
 * version, so each fetches its new answer; a refresh that changed nothing keeps the address and the
 * answer it has. The version of this request's page: its looked-up facts (a render for a page) or
 * its recorded snapshot (in the page) — hashed once per request; `''` when there is no data.
 */
export function render_page_version(event: RequestEvent | undefined, snapshot: PageSnapshot | undefined): string {
	if (!event) return '';
	const known = versions.get(event.request);
	if (known !== undefined) return known;
	const data = renders_for_a_page(event) ? facts_of.get(event.request)?.data : snapshot?.data;
	let v = '';
	if (data && typeof data === 'object') {
		try {
			v = fnv1a(JSON.stringify(data));
		} catch {
			/* a value JSON cannot write (a cycle, a bigint): no version, the address is the call alone */
		}
	}
	// (no data yet — a hole minted before the page recorded its snapshot — is not remembered)
	if (v) versions.set(event.request, v);
	return v;
}

/** 32-bit FNV-1a, base36: a version tag, not a security boundary. */
function fnv1a(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

const asks_of = new WeakMap<Request, SeedKeys>();

/**
 * An island rendering FOR a page asks for the `page.data` keys its client reads (Region.svelte's
 * record, the build's answer): kept for the answer's facts. `true` when the request renders for a
 * page — the ask is this model's, never a page render's snapshot.
 */
export function note_render_page_ask(event: RequestEvent, seed: SeedAsk): boolean {
	if (!renders_for_a_page(event)) return false;
	if (seed !== false) {
		const merged = merge_seed_ask(asks_of.get(event.request) ?? null, seed);
		if (merged) asks_of.set(event.request, merged);
	}
	return true;
}

/**
 * ONE PAGE, NOT TWO: what an answer rendered FOR a page carries — the looked-up `page.data` keys its
 * islands read, so they hydrate against the values their HTML was rendered from (the runtime merges
 * them into the page store: seeds.ts). `''` when no island in it reads the page, the page was not
 * looked up, or a value does not serialize (a still-streaming promise).
 */
export function render_page_facts_script(event: RequestEvent | undefined, transport: Transport | undefined): string {
	if (!event || !renders_for_a_page(event)) return '';
	const facts = facts_of.get(event.request);
	const keys = asks_of.get(event.request);
	if (!facts || !keys) return '';
	const encoders: Record<string, (v: unknown) => unknown> = {};
	for (const name in transport ?? {}) encoders[name] = transport![name].encode;
	try {
		// (devalue output is `<`-safe by itself: no second pass for the script element)
		return `<script type="${PAGE_FACTS_SCRIPT_TYPE}">${devalue.stringify(shape_page_data(facts.data, keys), encoders)}</script>`;
	} catch {
		return '';
	}
}
