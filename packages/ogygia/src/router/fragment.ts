/**
 * EXPERIMENTAL — fragment federation for the v2 router (design + POC log: internal/notes/mfe.md).
 *
 * Two halves of one wire:
 *   - MFE side:  `expose(router)` — serves the WHOLE route tree as a path-keyed fragment
 *     endpoint (`/og/fragment/page`). Any method forwards into the router; the full-document
 *     Response converts to the wire DOCUMENT `{ status, location?, title, css[], body }` with
 *     asset refs absolutized to the MFE's origin.
 *   - Shell side: `client(origin)` — ONE transport per MFE (signing, timeout, SWR cache,
 *     coalescing, invalidation). Its consumers: `mount(client)` — one route-table entry mounts
 *     the whole app (`'/cms/[...rest]': mount(cms)`; GET loads the document, POST forwards the
 *     form body and follows the MFE's PRG redirect; the wire document renders as a pure-HTML
 *     region — title+css join the document head, the body lands verbatim, and islands inside
 *     carry absolute entries so the shell's runtime schedules them while the MFE's build
 *     hydrates them); `client.widget(name)` — one named
 *     catalog fragment for an app's own SSR stitch; `proxy({ app })` — the lazy client-stitch's
 *     shell endpoint (the browser only ever talks to the shell).
 *
 * POC shortcuts (the real feature would): stream instead of buffer; carry a head channel
 * beyond title; pass upstream 4xx/5xx status through the shell render (today the MFE's error
 * BODY renders under shell chrome but the shell's status is 200); sign/catalog the endpoint.
 */
import { error, redirect, is_http_error } from './respond.js';
import { assigned_buckets, type ComponentPick } from '../flags.js';
import { page } from './define.js';
import type { PageDef } from './define.js';
import type { Router } from './router.js';
import type { Ctx } from './ctx.js';
import {
	createPrivateKey,
	createPublicKey,
	createHash,
	randomBytes,
	sign as ed_sign,
	verify as ed_verify
} from 'node:crypto';

// ── caller signing (Ed25519) ─────────────────────────────────────────────────────────────────
// Every server-to-server fragment hop is SIGNED by the caller and VERIFIED at the MFE's door.
// Asymmetric on purpose: MFEs hold only the shell's PUBLIC key — no shared secret to distribute,
// rotate, or leak (the same reason the catalog replaced capability HMACs). The signature covers
// timestamp + method + path?query + sha256(body), bounding tampering AND replay.

const SIG_HEADER = 'x-og-sig';
const TS_HEADER = 'x-og-ts';
const USER_HEADER = 'x-og-user';
const NONCE_HEADER = 'x-og-n';
const DEFAULT_SKEW_MS = 120_000;

// ── replay defense ───────────────────────────────────────────────────────────────────────────
// A signature is unique per (key, payload) and the payload carries `ts` in ms, so a byte-identical
// REPLAY reuses the same signature — reject a signature already seen inside its freshness window.
// Only VERIFIED signatures are recorded (an attacker can't grow this without the private key), and
// expired entries are swept on write, so the map stays bounded to (legit request rate × window).
// Process-local: a multi-instance MFE gets per-instance replay protection — audience binding is the
// cross-cutting guarantee, this is the same-instance backstop. Documented, not a distributed nonce store.
const seen_sigs = new Map<string, number>();
/** Hard ceiling: rate×window bounds this in practice, but MIXED skew windows across configs can
 *  break the insertion≈expiry ordering the cheap sweep relies on — never trust "should be
 *  bounded" at scale. Past the cap, a FULL sweep runs; if everything is genuinely live, oldest
 *  entries drop (their replay window shrinks rather than memory growing without bound). */
const MAX_SEEN_SIGS = 100_000;
/** @returns true if this signature is a replay (already seen, unexpired). Records it otherwise. */
function replay_seen(sig: string, expires_at: number, now: number): boolean {
	if (seen_sigs.size > 0) {
		for (const [k, exp] of seen_sigs) {
			if (exp <= now) seen_sigs.delete(k);
			else break; // insertion order ≈ expiry order (uniform window) — stop at first live
		}
	}
	if (seen_sigs.has(sig)) return true;
	if (seen_sigs.size >= MAX_SEEN_SIGS) {
		for (const [k, exp] of seen_sigs) if (exp <= now) seen_sigs.delete(k); // full sweep
		while (seen_sigs.size >= MAX_SEEN_SIGS) {
			// still full → drop oldest (bounded memory beats a perfect replay window)
			const oldest = seen_sigs.keys().next().value as string;
			seen_sigs.delete(oldest);
		}
	}
	seen_sigs.set(sig, expires_at);
	return false;
}

/** Visitor claims — who is BROWSING (the caller signature says who is CALLING). Bound into the
 *  signed payload: forging claims means forging the Ed25519 signature. They never transit the
 *  browser — the shell attaches them server-side from its own session. */
export type Claims = Record<string, unknown>;

/** In-process only: verified claims ride the forwarded Request as a Symbol property — an HTTP
 *  caller cannot set a JS symbol, so the MFE's standalone (unsigned) front door can never smuggle
 *  identity in through a header. */
const CLAIMS = Symbol.for('ogygia.claims.v1');

/** Read the VERIFIED visitor claims in any load / action / endpoint of an exposed router.
 *  `undefined` on the standalone front door and for anonymous calls. */
export function user<T extends Claims = Claims>(c: { request: Request }): T | undefined {
	return (c.request as unknown as Record<symbol, T | undefined>)[CLAIMS];
}

const body_hash = (body?: ArrayBuffer | Uint8Array | null) =>
	createHash('sha256')
		.update(body ? new Uint8Array(body as ArrayBuffer) : new Uint8Array(0))
		.digest('base64');

// ── KeyObject caches ─────────────────────────────────────────────────────────────────────────
// DER parsing dominates the crypto: sign with a fresh createPrivateKey each call is ~48μs vs
// ~17μs cached (2.9x); verify ~56μs vs ~39μs — and the verify loop parses PER key PER audience.
// Keys are few and static (env config), so cache parsed KeyObjects by their base64 string.
// Hard-capped as a safety valve: a caller cycling arbitrary key strings (a bug, not a use case)
// must not grow these forever.
const MAX_CACHED_KEYS = 64;
const private_keys = new Map<string, ReturnType<typeof createPrivateKey>>();
const public_keys = new Map<string, ReturnType<typeof createPublicKey>>();
function private_key(b64: string) {
	let k = private_keys.get(b64);
	if (!k) {
		k = createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
		if (private_keys.size >= MAX_CACHED_KEYS) private_keys.clear();
		private_keys.set(b64, k);
	}
	return k;
}
function public_key(b64: string) {
	let k = public_keys.get(b64);
	if (!k) {
		k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
		if (public_keys.size >= MAX_CACHED_KEYS) public_keys.clear();
		public_keys.set(b64, k);
	}
	return k;
}

// The signed payload binds the AUDIENCE (the target host) so a hop signed for one MFE cannot be
// replayed at a sibling MFE that trusts the same key — the confused-deputy the fixed fragment path
// + shared shell key would otherwise allow. Default audience = the URL host; override on both ends
// (ClientOptions.audience / VerifyConfig.audience) when a proxy rewrites Host between the hops.
// The NONCE makes every signature unique: Ed25519 is DETERMINISTIC, so without it two identical
// requests signed in the same millisecond (same path, same claims, empty body — which legitimate
// concurrent traffic produces) yield byte-identical signatures, and the replay guard would reject
// the second as a replay. Found by the load test: 8% false 401s at 20-way concurrency.
const sig_payload = (
	ts: string,
	method: string,
	pathq: string,
	bhash: string,
	claims: string,
	aud: string,
	nonce: string
) => Buffer.from(`${ts}.${method.toUpperCase()}.${pathq}.${bhash}.${claims}.${aud}.${nonce}`);

/** Caller side: headers proving "the holder of this private key sent EXACTLY this request, to THIS
 *  audience, now". `privateKey` is a base64 PKCS8 DER Ed25519 key (e.g. from env). `audience`
 *  defaults to the target URL's host. */
export function sign_headers(
	privateKey: string,
	method: string,
	url: URL,
	body?: ArrayBuffer | Uint8Array | null,
	claims?: Claims,
	audience?: string
): Record<string, string> {
	const key = private_key(privateKey);
	const ts = String(Date.now());
	const nonce = randomBytes(8).toString('hex');
	const pathq = url.pathname + url.search;
	const user_b64 = claims ? Buffer.from(JSON.stringify(claims)).toString('base64') : '';
	const sig = ed_sign(
		null,
		sig_payload(ts, method, pathq, body_hash(body), user_b64, audience ?? url.host, nonce),
		key
	);
	return {
		[TS_HEADER]: ts,
		[NONCE_HEADER]: nonce,
		[SIG_HEADER]: sig.toString('base64'),
		...(user_b64 ? { [USER_HEADER]: user_b64 } : {})
	};
}

export interface VerifyConfig {
	/** base64 SPKI DER Ed25519 public keys of AUTHORIZED callers (multiple = rotation/multi-shell). */
	publicKeys: string[];
	/** Max clock skew / replay window in ms (default 120s). */
	skewMs?: number;
	/** The audience(s) THIS MFE answers to — the caller must have signed for one of them. Defaults
	 *  to the request URL's host; set explicitly (the MFE's public hostname[s]) when a reverse proxy
	 *  rewrites Host so the caller's target host ≠ the host this process sees. */
	audience?: string | string[];
}

/** MFE side: fresh, valid, non-replayed signature from an authorized caller, bound to THIS
 *  audience? Returns the (signature-bound) visitor claims on success, `null` on any failure. */
export function verify_fragment_request(
	cfg: VerifyConfig,
	request: Request,
	url: URL,
	body?: ArrayBuffer | Uint8Array | null
): { user?: Claims } | null {
	const ts = request.headers.get(TS_HEADER);
	const sig = request.headers.get(SIG_HEADER);
	if (!ts || !sig) return null;
	const ts_n = Number(ts);
	// a non-numeric ts → NaN; guard it, else `NaN > window` is false and the freshness gate is
	// silently bypassed (defense-in-depth: the signature still binds ts, but never rely on that alone)
	const skew = cfg.skewMs ?? DEFAULT_SKEW_MS;
	const now = Date.now();
	if (!Number.isFinite(ts_n) || Math.abs(now - ts_n) > skew) return null;
	const user_b64 = request.headers.get(USER_HEADER) ?? '';
	const nonce = request.headers.get(NONCE_HEADER) ?? '';
	const bhash = body_hash(body);
	const pathq = url.pathname + url.search;
	const audiences = cfg.audience == null ? [url.host] : ([] as string[]).concat(cfg.audience);
	const sig_buf = Buffer.from(sig, 'base64');
	for (const aud of audiences) {
		const payload = sig_payload(ts, request.method, pathq, bhash, user_b64, aud, nonce);
		for (const pk of cfg.publicKeys) {
			try {
				const key = public_key(pk);
				if (!ed_verify(null, payload, key, sig_buf)) continue;
				// authentic + fresh + right audience — now reject a byte-identical replay
				if (replay_seen(sig, ts_n + skew, now)) return null;
				if (!user_b64) return {};
				try {
					return { user: JSON.parse(Buffer.from(user_b64, 'base64').toString()) as Claims };
				} catch {
					return null; // signed but unparseable claims = reject
				}
			} catch {
				// malformed key entry — try the next
			}
		}
	}
	return null;
}

/** The wire document a routes-fragment answers with. */
export interface FragmentDocument {
	status: number;
	/** 3xx target (already in the MFE's OWN base space, e.g. `/cms/posts/1`). */
	location?: string;
	title: string;
	/** `<link rel="stylesheet">` / `<style>` tags, asset hrefs absolute to the MFE origin. */
	css: string[];
	/** HEAD CHANNEL: the MFE page's SEO/social head bits (`<meta>` + canonical links; never
	 *  charset/viewport/http-equiv — those are the shell's). Joins the shell's document head. */
	head?: string;
	body: string;
	/** Absolute URL of the MFE's OWN ogygia runtime. An ogygia shell ignores this (it has its
	 *  own scheduler); a FOREIGN host (PHP, Rails, plain HTML — anything that can print a script
	 *  tag) loads it to wake the fragment's islands: one build end-to-end, no version mixing. */
	runtime?: string;
	/** OBSERVABILITY: the trace this render belonged to (continued from the caller's traceparent,
	 *  minted when absent) + how long the MFE spent producing it. "Which team made the page slow"
	 *  becomes one query instead of a three-team argument. */
	trace?: { trace_id: string; span_id: string };
	server_ms?: number;
}

// ── W3C trace context ────────────────────────────────────────────────────────────────────────
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const hex = (n: number) => randomBytes(n).toString('hex');

/** Continue the caller's trace (same trace-id, fresh span) or mint one. */
export function child_traceparent(incoming?: string | null): {
	traceparent: string;
	trace_id: string;
	span_id: string;
} {
	const m = incoming ? TRACEPARENT_RE.exec(incoming) : null;
	const trace_id = m ? m[1] : hex(16);
	const span_id = hex(8);
	return { traceparent: `00-${trace_id}-${span_id}-01`, trace_id, span_id };
}

/** The fixed endpoint path `expose()` serves and `mount()` calls — the module IS the convention. */
export const FRAGMENT_ROUTES_PATH = '/og/fragment/page';

const ABSOLUTE_RE = /^[a-z][a-z0-9+.-]*:|^\/\//i;
const ASSET_ATTR_RE = /\b(entry|endpoint|href|src)="([^"]+)"/g;
const ASSET_PATH_RE = /(?:^|\/)(_app|og)\//;
const ASSET_EXT_RE = /\.(js|css|woff2?)(\?|$)/;
const HEAD_RE = /<head[^>]*>([\s\S]*?)<\/head>/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const STYLESHEET_LINK_RE = /<link\b[^>]*rel="stylesheet"[^>]*>/gi;
const STYLE_TAG_RE = /<style[\s\S]*?<\/style>/gi;
const BODY_RE = /<body[^>]*>([\s\S]*)<\/body>/i;
const RUNTIME_SCRIPT_RE = /<script[^>]*data-ogygia-runtime[^>]*src="([^"]+)"/i;
// HEAD CHANNEL: the meta tags worth carrying to the shell (SEO/social — description, og:*,
// twitter:*, robots, canonical links). charset/viewport/http-equiv stay the SHELL's: the shell
// owns the document, and duplicating those is at best noise, at worst a conflict.
const META_TAG_RE = /<meta\b[^>]*>|<link\b[^>]*rel="canonical"[^>]*>/gi;
const SHELL_OWNED_META_RE = /\bcharset\b|http-equiv|name="viewport"/i;

/** Pin ASSET refs (island entries, stylesheets, chunks) to `origin`; app-local LINKS stay
 *  path-relative — the consuming shell owns the address space they resolve in. */
function absolutize(html: string, origin: string): string {
	return html.replace(ASSET_ATTR_RE, (_m, attr: string, value: string) => {
		if (ABSOLUTE_RE.test(value)) return `${attr}="${value}"`;
		if (!ASSET_PATH_RE.test(value) && !ASSET_EXT_RE.test(value)) return `${attr}="${value}"`;
		return `${attr}="${new URL(value, origin + '/').href}"`;
	});
}

type KitishEvent = { request: Request; url: URL };
type FragmentHandler = (event: KitishEvent) => Promise<Response>;

/**
 * MFE side. `export const { GET, POST, PUT, PATCH, DELETE } = expose(router, { base })` in the
 * `+server.ts` at {@link FRAGMENT_ROUTES_PATH}.
 */
/** Default cap on a forwarded fragment body (form posts are small; 1MB is generous). */
const DEFAULT_MAX_BODY = 1024 * 1024;

export function expose(
	router: Router,
	opts: { base?: string; verify?: VerifyConfig | false; maxBodyBytes?: number } = {}
): Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', FragmentHandler> {
	const base = opts.base ?? '';
	const max_body = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
	// FAIL-CLOSED by default: forgetting `verify` used to silently serve fragments (and follow
	// forwarded requests) to anyone. Warn loudly instead. Deliberate no-auth (behind a service
	// mesh / mTLS) is `verify: false` — explicit, so it can't be an accident.
	if (opts.verify === undefined) {
		console.warn(
			'[ogygia] expose() has no `verify` — this fragment endpoint is UNAUTHENTICATED (anyone ' +
				'who can reach it gets your rendered pages). Pass `verify: { publicKeys }` to require ' +
				'Ed25519-signed callers, or `verify: false` to acknowledge an intentionally open endpoint.'
		);
	}
	const verify = opts.verify || null;
	const handler: FragmentHandler = async ({ request, url }) => {
		const t0 = performance.now();
		// continue the caller's trace (or start one) — the SAME trace-id flows shell → here →
		// anything THIS app stitches downstream (it forwards the child traceparent)
		const trace = child_traceparent(request.headers.get('traceparent'));
		const path = url.searchParams.get('path') ?? '/';
		const search = url.searchParams.get('search') ?? '';
		const target = new URL(base + (path.startsWith('/') ? path : '/' + path) + search, url.origin);

		// BODY CAP BEFORE BUFFERING — verification needs the body (its hash is signed), so the read
		// happens pre-auth: without a cap an UNAUTHENTICATED caller could stream gigabytes straight
		// into this process's memory. Reject on content-length when present (O(1)); a chunked lie
		// is caught right after the read, before any hashing/verification work.
		let body: ArrayBuffer | undefined;
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			const cl = Number(request.headers.get('content-length'));
			if (Number.isFinite(cl) && cl > max_body)
				return new Response(JSON.stringify({ error: 'body too large' }), {
					status: 413,
					headers: { 'content-type': 'application/json' }
				});
			body = await request.arrayBuffer();
			if (body.byteLength > max_body)
				return new Response(JSON.stringify({ error: 'body too large' }), {
					status: 413,
					headers: { 'content-type': 'application/json' }
				});
		}

		// Signature gate FIRST: unauthorized callers learn nothing (401 before any routing/render).
		let verified: { user?: Claims } | null = null;
		if (verify) {
			verified = verify_fragment_request(verify, request, url, body);
			if (!verified) {
				return new Response(JSON.stringify({ error: 'invalid or missing signature' }), {
					status: 401,
					headers: { 'content-type': 'application/json' }
				});
			}
		}
		const fwd = new Request(target, { method: request.method, headers: request.headers, body });
		// verified claims ride IN-PROCESS only (Symbol prop) — and the raw header is stripped so
		// nothing downstream can mistake an unverified header for identity
		fwd.headers.delete('x-og-user');
		// the router's loads see the CHILD traceparent — their own downstream stitches continue it
		fwd.headers.set('traceparent', trace.traceparent);
		if (verified?.user)
			(fwd as unknown as Record<symbol, Claims>)[Symbol.for('ogygia.claims.v1')] = verified.user;
		const res = await router.fetch(fwd);

		const doc = (d: FragmentDocument) => {
			const ms = Math.round((performance.now() - t0) * 10) / 10;
			return new Response(
				JSON.stringify({
					...d,
					trace: { trace_id: trace.trace_id, span_id: trace.span_id },
					server_ms: ms
				}),
				{
					headers: {
						'content-type': 'application/json',
						'server-timing': `og-fragment;dur=${ms}`
					}
				}
			);
		};

		if (!res)
			return doc({ status: 404, title: 'not found', css: [], body: 'router did not match' });
		if (res.status >= 300 && res.status < 400) {
			return doc({
				status: res.status,
				location: res.headers.get('location') ?? '/',
				title: '',
				css: [],
				body: ''
			});
		}

		const html = await res.text();
		const head = html.match(HEAD_RE)?.[1] ?? '';
		const runtime_src = html.match(RUNTIME_SCRIPT_RE)?.[1];
		// head channel: SEO/social meta + canonical links, minus what the shell owns
		const head_meta = (head.match(META_TAG_RE) ?? [])
			.filter((t) => !SHELL_OWNED_META_RE.test(t))
			.map((t) => absolutize(t, url.origin))
			.join('');
		return doc({
			status: res.status,
			title: head.match(TITLE_RE)?.[1] ?? '',
			css: [...(head.match(STYLESHEET_LINK_RE) ?? []), ...(head.match(STYLE_TAG_RE) ?? [])].map(
				(t) => absolutize(t, url.origin)
			),
			...(head_meta ? { head: head_meta } : {}),
			body: absolutize(html.match(BODY_RE)?.[1] ?? html, url.origin),
			...(runtime_src ? { runtime: new URL(runtime_src, url.origin + '/').href } : {})
		});
	};
	return { GET: handler, POST: handler, PUT: handler, PATCH: handler, DELETE: handler };
}

// ── the WIDGET CATALOG (MFE side) ────────────────────────────────────────────────────────────
/** What a catalog widget function receives alongside the browser/shell-chosen props. */
export interface WidgetInfo {
	/** Signature-bound visitor claims (undefined when unverified/anonymous). AUTHORIZE what the
	 *  widget returns against THESE — props are caller-chosen, claims are not. */
	user?: Claims;
	request: Request;
	url: URL;
}

/** A widget: props in, an awaitable `{ html }` out — `await region(Comp, props)` IS that shape
 *  (the held-region bake renders the component with its islands + prefixed scoped-CSS links). */
export type Widget = (
	props: Record<string, string>,
	info: WidgetInfo
) => PromiseLike<{ html: string | null }> | { html: string | null };

/**
 * The MFE's NAMED WIDGET CATALOG — `export const { GET } = catalog({ kpis }, { verify })` in the
 * `+server.ts` at `og/fragment/[name]`. Each widget bakes per request; asset refs absolutize to
 * this origin so a consuming shell's page fetches CSS + island chunks from HERE. The reserved
 * name `__catalog` answers the MANIFEST (`{ names }`) — consumers record it in CI and diff per
 * release, so a renamed/removed widget is a build-time conversation, not a prod 404.
 */
export function catalog(
	widgets: Record<string, Widget | { props: readonly string[]; make: Widget }>,
	opts: { verify?: VerifyConfig | false } = {}
): {
	GET: (e: {
		params: Partial<Record<string, string>>;
		url: URL;
		request: Request;
	}) => Promise<Response>;
} {
	if (opts.verify === undefined) {
		console.warn(
			'[ogygia] catalog() has no `verify` — these widget endpoints are UNAUTHENTICATED. Pass ' +
				'`verify: { publicKeys }`, or `verify: false` to acknowledge an intentionally open catalog.'
		);
	}
	const verify = opts.verify || null;
	// normalized: name → { make, props? }. Declared props are DOCUMENTATION for the manifest —
	// `npx ogygia fragments` turns them into typed stubs; the endpoint itself stays permissive
	// (widgets must authorize by claims regardless — props were never a trust input).
	const entries = new Map<string, { make: Widget; props?: readonly string[] }>();
	for (const [k, v] of Object.entries(widgets)) {
		entries.set(k, typeof v === 'function' ? { make: v } : { make: v.make, props: v.props });
	}
	const names = [...entries.keys()].sort();
	const manifest_widgets = Object.fromEntries(
		names.map((n) => [n, { props: [...(entries.get(n)!.props ?? [])].sort() }])
	);

	return {
		GET: async ({ params, url, request }) => {
			const name = params.name ?? '';
			// The MANIFEST is deliberately UNSIGNED (names only — content stays gated below):
			// CI diffs and `npx ogygia fragments` need it without key ceremony, the same trade
			// as a /.well-known discovery document. Widget names are inventory, not data.
			if (name === '__catalog')
				return new Response(JSON.stringify({ names, widgets: manifest_widgets }), {
					headers: { 'content-type': 'application/json' }
				});
			let user: Claims | undefined;
			if (verify) {
				const v = verify_fragment_request(verify, request, url);
				if (!v) return json_error_response(401, 'invalid or missing signature');
				user = v.user;
			}
			const make = entries.get(name)?.make;
			if (!make) return json_error_response(404, `unknown fragment '${name}'`);
			const trace = child_traceparent(request.headers.get('traceparent'));
			const t0 = performance.now();
			const props: Record<string, string> = {};
			for (const [k, v] of url.searchParams) props[k] = v;
			const baked = await make(props, { user, request, url });
			if (baked?.html == null) return json_error_response(500, 'fragment did not bake');
			const ms = Math.round((performance.now() - t0) * 10) / 10;
			return new Response(
				JSON.stringify({
					html: absolutize(baked.html, url.origin),
					origin: url.origin,
					trace: { trace_id: trace.trace_id, span_id: trace.span_id },
					server_ms: ms
				}),
				{
					headers: {
						'content-type': 'application/json',
						'server-timing': `og-fragment;dur=${ms}`
					}
				}
			);
		}
	};
}

const json_error_response = (status: number, error: string) =>
	new Response(JSON.stringify({ error, status }), {
		status,
		headers: { 'content-type': 'application/json' }
	});

// ── the CLIENT: one transport per MFE ────────────────────────────────────────────────────────
// ALL policy for talking to one MFE lives here — signing, timeout, SWR cache, coalescing,
// generation-safe invalidation. mount() (whole-app pages), widget() (SSR stitch), and proxy()
// (the lazy client-stitch's server half) consume the SAME client instead of hand-rolling the
// fetch trio. The client is request-agnostic: per-request facts (claims, traceparent) are call
// arguments, so one instance is safely shared across requests and consumers.

export interface ClientOptions {
	/** base64 PKCS8 DER Ed25519 PRIVATE key — every hop to this MFE is signed with it. */
	sign?: { privateKey: string };
	/** Server-Timing metric name (default: the origin's host, sanitized). */
	name?: string;
	/** Max ms per UNCACHED upstream call; a miss becomes a 504 boundary card (bounded latency:
	 *  the shell's page is never held hostage by a slow team). Default 5000. */
	timeout?: number;
	/** Stale-while-revalidate document cache for page documents. Within `ttl` ms a hit serves
	 *  instantly with NO upstream call; after `ttl` the STALE doc serves immediately while a
	 *  background refresh updates the cache. Mutations (POST) invalidate. Off when omitted.
	 *  `max` bounds the entry count (default 500, LRU-evicted): the key includes the VISITOR's
	 *  claims, so cardinality is visitors × paths — an unbounded map here is a slow memory leak
	 *  on any personalized mount at scale. */
	cache?: { ttl: number; max?: number };
	/** The audience string signed into every hop (must equal the MFE's `verify.audience`).
	 *  Defaults to the origin's host — set both ends explicitly only when a proxy rewrites Host. */
	audience?: string;
}

/** What a named catalog fragment (`/og/fragment/<name>`) answers with. */
export interface WidgetDocument {
	html: string;
	origin?: string;
	trace?: { trace_id: string; span_id: string };
	server_ms?: number;
}

export interface FragmentClient {
	readonly origin: string;
	/** Server-Timing label for this MFE. */
	readonly label: string;
	/** Page document (whole-app mount's GET path) — cache/SWR/coalescing-managed. Throws the
	 *  router's `error()` (502/504) — call from loads/actions. */
	doc(
		path: string,
		search: string,
		claims?: Claims,
		traceparent?: string
	): Promise<FragmentDocument>;
	/** Mutation document — bypasses the cache and INVALIDATES it (generation-safe). */
	postDoc(
		path: string,
		search: string,
		body: ArrayBuffer,
		content_type: string,
		claims?: Claims,
		traceparent?: string
	): Promise<FragmentDocument>;
	/** A named WIDGET fragment from the MFE's catalog — signed + timeout-bounded. Throws a plain
	 *  `Error` on any failure (callable from ANY server code — degrade to your own card). */
	widget(
		name: string,
		props?: Record<string, string>,
		opts?: { claims?: Claims; traceparent?: string }
	): Promise<WidgetDocument>;
}

/** One transport per MFE: `const cms = client('http://cms.internal', { sign, timeout, cache })`.
 *  Hand it to `mount(cms)`, `proxy({ cms })`, or call `cms.widget()` in your own stitch. */
export function client(
	origin_or_origins: string | string[],
	opts: ClientOptions = {}
): FragmentClient {
	// FAILOVER: extra origins are same-build replicas tried IN ORDER when an earlier one is
	// unreachable or answers 5xx — READS only (a retried mutation risks a double write; POSTs
	// stay pinned to the primary). Signing binds each attempt to ITS target host automatically
	// (the audience defaults to the URL's host), and cache/coalescing state is shared — a
	// replica serves the same documents.
	const origins = Array.isArray(origin_or_origins) ? origin_or_origins : [origin_or_origins];
	const origin = origins[0];
	const timeout = opts.timeout ?? 5000;
	const ttl = opts.cache?.ttl ?? 0;
	const cache_max = opts.cache?.max ?? 500;
	/** LRU bookkeeping: refresh recency on hit, evict oldest past `cache_max` on insert. The key
	 *  carries the visitor's claims — cardinality is visitors × paths, so unbounded = memory leak. */
	const cache_put = (key: string, entry: { doc: FragmentDocument; at: number }) => {
		if (cache.has(key))
			cache.delete(key); // re-insert = most recent
		else if (cache.size >= cache_max) cache.delete(cache.keys().next().value as string);
		cache.set(key, entry);
	};
	/** Server-Timing metric name (DevTools shows `<name>;dur=` per team). */
	const label = opts.name ?? new URL(origin).host.replace(/[^a-zA-Z0-9_-]/g, '-');
	/** path+search+claims → cached document + fetch coalescing (concurrent misses share ONE call). */
	const cache = new Map<string, { doc: FragmentDocument; at: number }>();
	const inflight = new Map<string, Promise<FragmentDocument>>();
	// Invalidation generation: an in-flight fetch that STARTED before a mutation cleared the
	// cache must not repopulate it with pre-mutation data when it lands (found by the chaos
	// mutation test — the SWR background refresh raced the POST's clear()).
	let generation = 0;

	/** Sign + bound + send — every hop to this MFE goes through here. */
	const signed_fetch = (
		u: URL,
		init: (RequestInit & { body?: ArrayBuffer }) | undefined,
		claims?: Claims,
		traceparent?: string
	): Promise<Response> => {
		const signed = opts.sign
			? sign_headers(
					opts.sign.privateKey,
					init?.method ?? 'GET',
					u,
					init?.body,
					claims,
					opts.audience
				)
			: {};
		return fetch(u, {
			signal: AbortSignal.timeout(timeout),
			...init,
			headers: {
				...(init?.headers as Record<string, string>),
				...signed,
				...(traceparent ? { traceparent } : {})
			}
		});
	};

	const raw_doc = async (
		path: string,
		search: string,
		init?: RequestInit & { body?: ArrayBuffer },
		claims?: Claims,
		traceparent?: string
	): Promise<FragmentDocument> => {
		const is_read = !init?.method || init.method === 'GET';
		const pool = is_read ? origins : [origin]; // mutations never fail over
		let res: Response | undefined;
		let last_err: unknown;
		for (let i = 0; i < pool.length; i++) {
			const u = new URL(FRAGMENT_ROUTES_PATH, pool[i]);
			u.searchParams.set('path', path);
			if (search) u.searchParams.set('search', search);
			try {
				res = await signed_fetch(u, init, claims, traceparent);
			} catch (e) {
				last_err = e; // unreachable / timed out — try the next replica
				continue;
			}
			if (res.status < 500 || i === pool.length - 1) break; // 5xx → next, unless last
		}
		if (!res) throw last_err;
		if (!res.ok && res.status !== 404) error(502, `fragment app answered ${res.status}`);
		return (await res.json()) as FragmentDocument;
	};

	/** GET path: cache-fresh → instant; cache-stale → serve stale, refresh in background;
	 *  miss → ONE coalesced upstream fetch bounded by `timeout`. */
	const fetch_doc = async (
		path: string,
		search: string,
		claims?: Claims,
		traceparent?: string
	): Promise<FragmentDocument> => {
		// personalized documents must never share a cache slot — the visitor is part of the key
		const key = path + '?' + search + '\u0000' + (claims ? JSON.stringify(claims) : '');
		const hit = ttl > 0 ? cache.get(key) : undefined;
		if (hit) {
			cache_put(key, hit); // LRU touch — a hot personalized page must not be the eviction victim
			if (Date.now() - hit.at >= ttl && !inflight.has(key)) {
				// STALE: hand back the old doc NOW, refresh behind the scenes (SWR)
				const gen = generation;
				const p = raw_doc(path, search, undefined, claims, traceparent)
					.then((doc) => {
						if (gen === generation && !doc.location) cache_put(key, { doc, at: Date.now() });
						return doc;
					})
					.finally(() => inflight.delete(key));
				inflight.set(key, p);
				p.catch(() => {}); // a failed revalidate keeps serving stale — never breaks the page
			}
			return hit.doc;
		}
		let p = inflight.get(key);
		if (!p) {
			const gen = generation;
			p = raw_doc(path, search, undefined, claims, traceparent)
				.then((doc) => {
					if (gen === generation && ttl > 0 && !doc.location && doc.status < 400)
						cache_put(key, { doc, at: Date.now() });
					return doc;
				})
				.finally(() => inflight.delete(key));
			inflight.set(key, p);
		}
		try {
			return await p;
		} catch (e) {
			if (is_http_error(e)) throw e;
			// timeout or network failure — bounded, boundary-renderable
			error(504, 'This section is temporarily unavailable.');
		}
	};

	return {
		origin,
		label,
		doc: fetch_doc,
		async postDoc(path, search, body, content_type, claims, traceparent) {
			// mutations NEVER touch the cache path, and a successful one invalidates it — the next
			// GET re-reads the MFE's post-mutation truth. The generation bump makes any
			// STILL-IN-FLIGHT pre-mutation fetch unable to repopulate the cache.
			generation++;
			cache.clear();
			inflight.clear();
			return raw_doc(
				path,
				search,
				{
					method: 'POST',
					headers: {
						'content-type': content_type,
						// Kit's CSRF gate on the MFE rejects form POSTs whose origin header
						// doesn't match its own — this hop speaks AS the MFE.
						origin
					},
					body
				},
				claims,
				traceparent
			);
		},
		async widget(name, props = {}, w = {}) {
			// plain Error (not the router's error()) — widget() runs in ANY server code, where the
			// right failure mode is the CALLER's degrade card, not a thrown response. Reads fail
			// over the replica pool like doc() does.
			let res: Response | undefined;
			let last_err: unknown;
			for (let i = 0; i < origins.length; i++) {
				const u = new URL(`/og/fragment/${name}`, origins[i]);
				for (const [k, v] of Object.entries(props)) u.searchParams.set(k, v);
				try {
					res = await signed_fetch(u, undefined, w.claims, w.traceparent);
				} catch (e) {
					last_err = e;
					continue;
				}
				if (res.status < 500 || i === origins.length - 1) break;
			}
			if (!res) throw last_err instanceof Error ? last_err : new Error(String(last_err));
			if (!res.ok) throw new Error(`fragment '${name}' answered ${res.status}`);
			return (await res.json()) as WidgetDocument;
		}
	};
}

export interface MountOptions extends ClientOptions {
	/** OVERRIDE the visitor claims for this mount. Default: `c.visitor` — the router's ONE
	 *  identity (`routes(table, { visitor })`) — with the table's `experiments` buckets
	 *  auto-carried alongside. Claims never transit the browser. */
	user?: (c: Ctx) => Claims | undefined;
	/** STREAM the mount: the shell's page flushes immediately with `fallback` (or a neutral
	 *  skeleton) in the slot, and the fragment swaps in down the SAME response when the MFE
	 *  answers — a slow team stops delaying the shell's first byte entirely. GET only (actions
	 *  stay buffered). Streaming's trades: the status/title flush before the doc arrives (a
	 *  late 404 shows the MFE's error BODY but the response was already 200), redirects render
	 *  a link card instead of redirecting, and per-team Server-Timing is lost. */
	stream?: boolean | { fallback?: string | unknown };
}

/** The on-behalf-of claims for a hop: the table's ONE identity + auto-carried flag decisions.
 *  Every `flag(c)` decided this request self-registers its bucket (see `assigned_buckets` — a page
 *  read, or a table `flags: […]` pre-decision), so a mounted team renders the visitor in the SAME
 *  world with no hand-listed map — forgetting an entry used to silently fork a visitor between
 *  teams. Explicit claims (override or base) win on collision. */
function claims_for(c: Ctx, user_override?: (c: Ctx) => Claims | undefined): Claims | undefined {
	const base = user_override ? user_override(c) : (c.visitor as Claims | undefined);
	const buckets = assigned_buckets(c.request);
	if (!buckets || Object.keys(buckets).length === 0) return base;
	return {
		...base,
		experiments: { ...buckets, ...((base?.experiments as object | undefined) ?? {}) }
	};
}

/**
 * Shell side. One route-table entry mounts a whole remote app:
 * `'/cms/[...rest]': mount(cms)` where `cms = client('http://cms.internal', { … })` — or
 * `mount('http://cms.internal', { timeout: 800, cache: { ttl: 30_000 } })` as inline sugar.
 *
 * CANARY / BLUE-GREEN: pass a PER-REQUEST resolver instead — the promised A/B-of-infrastructure:
 *
 *     const v2 = flag('cms-v2', { rollout: 10 });
 *     const v2 = flag('cms-v2', 10);
 *     '/cms/[...rest]': mount(v2.pick({ off: cms_v1, on: cms_v2 }))
 *
 * — the same `pick` verb that chooses components and values chooses infrastructure (a bare
 * `(c) => FragmentClient` resolver works too). Clients are prebuilt singletons (each keeps its
 * own cache/coalescing); the pick only CHOOSES between them, so stickiness comes from the flag,
 * federation carry keeps the canaried team consistent across the visitor's session, and
 * transport state stays per-target.
 */
function mount_fn(
	target: string | FragmentClient | ComponentPick | ((c: Ctx) => FragmentClient),
	opts: MountOptions = {}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): PageDef<any, any, any, any, any> {
	const fixed =
		typeof target === 'function'
			? null
			: typeof target === 'string'
				? client(target, opts)
				: '__ogpick' in target
					? null
					: target;
	const resolve_client = (c: Ctx): FragmentClient => {
		if (fixed) return fixed;
		const got =
			typeof target === 'function' ? target(c) : (target as ComponentPick).__ogpick(c as never);
		if (!got || typeof (got as FragmentClient).doc !== 'function')
			throw new Error(
				`[ogygia] mount(): the ${typeof target === 'function' ? 'resolver' : 'pick'} must yield a FragmentClient (a client(origin, …) instance).`
			);
		return got as FragmentClient;
	};

	// STREAM MODE: the page slot is a GENERATOR — fallback flushes with the shell's page, the
	// fragment swaps in down the same response when (and only when) the MFE answers. The hop
	// itself stays buffered + signed exactly as ever; only the browser-facing leg streams.
	if (opts.stream) {
		// fallback: an HTML string, or a COMPONENT (baked as an inline region — svelte/server is
		// imported lazily by the bake, so this module stays import-light for non-streaming hosts)
		const fb =
			typeof opts.stream === 'object' && opts.stream.fallback != null
				? opts.stream.fallback
				: '<div data-og-mount-fallback style="min-height:6rem;border-radius:8px;background:linear-gradient(90deg,#f3f4f6,#e5e7eb,#f3f4f6)"></div>';
		const stream_slot = async function* (c: Ctx) {
			if (typeof fb === 'string') yield fb;
			else {
				const { region } = await import('../region-core.js');
				yield region(fb as never, {});
			}
			const cl = resolve_client(c);
			const rest = (c.params as { rest?: string }).rest ?? '';
			try {
				const doc = await cl.doc(
					'/' + rest,
					c.url.search,
					claims_for(c, opts.user),
					child_traceparent(c.request.headers.get('traceparent')).traceparent
				);
				if (doc.location) {
					// the status flushed long ago — a redirect can only be OFFERED, not performed
					yield `<p data-og-mount-moved>This page moved. <a href="${doc.location}">Continue</a></p>`;
					return;
				}
				yield (doc.css?.join('') ?? '') + (doc.head ?? '') + doc.body;
			} catch {
				yield '<div data-og-mount-failed style="border:1px dashed #dc2626;border-radius:8px;padding:1rem;color:#dc2626">This section is temporarily unavailable.</div>';
			}
		};
		return page(stream_slot as never, {
			actions: {
				// mutations stay BUFFERED (an action needs a whole answer + its PRG redirect)
				default: async (c: Ctx) => {
					const cl = resolve_client(c);
					const rest = (c.params as { rest?: string }).rest ?? '';
					const body = await c.request.arrayBuffer();
					const doc = await cl.postDoc(
						'/' + rest,
						c.url.search,
						body,
						c.request.headers.get('content-type') ?? 'application/x-www-form-urlencoded',
						claims_for(c, opts.user),
						child_traceparent(c.request.headers.get('traceparent')).traceparent
					);
					if (doc.location) redirect(303, doc.location);
					return { doc };
				}
			}
		});
	}

	// The page slot is a RESOLVER into an html view — the wire document IS the page. No bespoke
	// component: the router renders it through ogygia's own pure-HTML region, the doc's css tags
	// + title join the document head, and the islands inside the body carry absolute entries the
	// shell's runtime schedules (their own build hydrates them).
	const mounted_view = {
		__ogpick: (_c: Ctx, data: Record<string, unknown>) => {
			const doc = data.doc as FragmentDocument;
			return {
				__oghtml: true as const,
				html: doc.body,
				css: doc.css,
				title: doc.title || undefined,
				head: doc.head,
				// STATUS CHANNEL: the MFE's own 404/500 page renders under shell chrome AND the
				// shell answers with the MFE's status — a 200-wrapped error page poisons caches/SEO
				status: doc.status
			};
		}
	};

	return page(mounted_view, {
		load: async (c) => {
			const cl = resolve_client(c);
			const rest = (c.params as { rest?: string }).rest ?? '';
			// continue the PAGE's trace into the hop (fresh span), and time the whole exchange —
			// the shell's own response then names the team in Server-Timing (visible in DevTools)
			const trace = child_traceparent(c.request.headers.get('traceparent'));
			const t0 = performance.now();
			const doc = await cl.doc(
				'/' + rest,
				c.url.search,
				claims_for(c, opts.user),
				trace.traceparent
			);
			const hop_ms = Math.round((performance.now() - t0) * 10) / 10;
			if (doc.location) redirect(doc.status as 301 | 302 | 303 | 307 | 308, doc.location);
			c.setHeaders?.({
				'server-timing':
					`${cl.label};dur=${hop_ms}` +
					(doc.server_ms != null ? `, ${cl.label}-render;dur=${doc.server_ms}` : ''),
				...(doc.trace ? { 'x-og-trace': doc.trace.trace_id } : {})
			});
			// 4xx/5xx: the MFE's OWN error page renders under shell chrome, and the view's status
			// channel makes the shell ANSWER with that status (no 200-wrapped error pages)
			return { doc };
		},
		actions: {
			default: async (c) => {
				const cl = resolve_client(c);
				const rest = (c.params as { rest?: string }).rest ?? '';
				const body = await c.request.arrayBuffer();
				const doc = await cl.postDoc(
					'/' + rest,
					c.url.search,
					body,
					c.request.headers.get('content-type') ?? 'application/x-www-form-urlencoded',
					claims_for(c, opts.user), // the visitor acts THROUGH the shell — signed into the write
					child_traceparent(c.request.headers.get('traceparent')).traceparent
				);
				if (doc.location) redirect(303, doc.location);
				return { doc }; // non-redirect action answer: re-render with the returned document
			}
		}
	});
}

/** The mount surface: call it (`mount(cms)` in a routes table), or mount from PLAIN SvelteKit
 *  with `mount.kit(cms)` (a catchall `+page.server.ts`, no ogygia router). One noun. */
export const mount = Object.assign(mount_fn, { kit: kit_mount });

// ── mount.kit: mounting WITHOUT ogygia's router ──────────────────────────────────────────────
/** A Kit-shaped server event — the structural subset kitMount touches. */
type KitMountEvent = {
	params: Partial<Record<string, string>>;
	url: URL;
	request: Request;
	setHeaders?: (headers: Record<string, string>) => void;
};

export interface KitMountOptions {
	/** Visitor claims for each hop — a plain Kit app has no `c.visitor`, so identity is read off
	 *  the EVENT (cookies / locals) explicitly. */
	user?: (e: KitMountEvent) => Claims | undefined;
	/** The catchall param name (`src/routes/cms/[...rest]` → 'rest'). Default 'rest'. */
	param?: string;
}

/**
 * Mount an MFE from a PLAIN SvelteKit catchall — no ogygia router needed. In
 * `src/routes/cms/[...rest]/+page.server.ts`:
 *
 *     const m = mount.kit(cms);                      // cms = client(origin, { sign, … })
 *     export const load = m.load;
 *     export const actions = m.actions;
 *
 * and a six-line `+page.svelte` renders the document (Kit owns composition here, so the page
 * component is the app's — see the docs snippet): title+css via `<svelte:head>`, body via
 * `{@html}`. Islands inside wake on ogygia's runtime like any mounted fragment.
 *
 * One honest difference from the router's `mount()`: Kit loads cannot set a response status, so
 * an upstream 4xx/5xx becomes Kit's `error(status)` — correct status, but the SHELL's error page
 * renders instead of the MFE's error body (the router's mount keeps both).
 */
function kit_mount(
	target: string | FragmentClient,
	opts: KitMountOptions = {}
): {
	load: (e: KitMountEvent) => Promise<{ doc: FragmentDocument }>;
	actions: { default: (e: KitMountEvent) => Promise<{ doc: FragmentDocument }> };
} {
	const cl = typeof target === 'string' ? client(target) : target;
	const param = opts.param ?? 'rest';
	// Kit's own error/redirect, imported LAZILY: kitMount only runs inside a Kit app, and a
	// static top-level import would make expose()/client() standalone hosts need Kit installed.
	const kit = () => import('@sveltejs/kit');

	return {
		load: async (e) => {
			const rest = e.params[param] ?? '';
			const trace = child_traceparent(e.request.headers.get('traceparent'));
			const t0 = performance.now();
			const doc = await cl.doc('/' + rest, e.url.search, opts.user?.(e), trace.traceparent);
			const hop_ms = Math.round((performance.now() - t0) * 10) / 10;
			const { error: kit_error, redirect: kit_redirect } = await kit();
			if (doc.location) kit_redirect(doc.status as 301, doc.location);
			e.setHeaders?.({
				'server-timing':
					`${cl.label};dur=${hop_ms}` +
					(doc.server_ms != null ? `, ${cl.label}-render;dur=${doc.server_ms}` : ''),
				...(doc.trace ? { 'x-og-trace': doc.trace.trace_id } : {})
			});
			if (doc.status >= 400) kit_error(doc.status, doc.title || 'This section is unavailable.');
			return { doc };
		},
		actions: {
			default: async (e) => {
				const rest = e.params[param] ?? '';
				const body = await e.request.arrayBuffer();
				const doc = await cl.postDoc(
					'/' + rest,
					e.url.search,
					body,
					e.request.headers.get('content-type') ?? 'application/x-www-form-urlencoded',
					opts.user?.(e),
					child_traceparent(e.request.headers.get('traceparent')).traceparent
				);
				const { redirect: kit_redirect } = await kit();
				if (doc.location) kit_redirect(303, doc.location);
				return { doc };
			}
		}
	};
}

/** A Kit-shaped event — what `proxy()`'s handler receives (it runs in a plain `+server.ts`,
 *  OUTSIDE the router, so there is no Ctx). */
type ProxyEvent = { params: Partial<Record<string, string>>; url: URL; request: Request };

const json_doc = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});

export interface ProxyOptions {
	/** The claims the shell signs onto EACH forwarded widget call — its OWN session, not the
	 *  browser's. Because the browser controls the widget name + all props here, a widget MUST
	 *  authorize the resources it returns against these claims (`c.visitor`), never against a
	 *  prop: props are attacker-chosen, claims are not. */
	user?: (e: ProxyEvent) => Claims | undefined;
	/** Allowlist of widget names the browser may reach, per app: `{ dash: ['kpis', 'chart'] }`.
	 *  Without it, `proxy` is an OPEN PROXY to any `/og/fragment/*` on every configured MFE —
	 *  the browser picks the name. Omit ONLY when every widget endpoint is itself hardened. */
	widgets?: Record<string, readonly string[]>;
}

/**
 * The lazy client-stitch's server half: `export const { GET } = proxy({ dash }, { widgets })` in
 * the shell's `/og/frag/[name]/+server.ts`. The browser fetches THE SHELL for fragment JSON —
 * never an MFE server (no CORS, no exposed internal hosts, one cookie domain). Param format
 * `<app>:<name>`; each app's transport policy (signing, timeout) is its client's. A dead MFE
 * answers `{ failed: true, reason }` — the hole renders its failed card, the page never breaks.
 *
 * SECURITY: this endpoint turns BROWSER input (the widget name + query props) into a shell-signed,
 * claims-bearing MFE call. Pass `widgets` to allowlist reachable names (else it is an open proxy),
 * and make widget endpoints authorize by claims, not props (see ProxyOptions).
 */
export function proxy(
	clients: Record<string, FragmentClient>,
	opts: ProxyOptions = {}
): { GET: (e: ProxyEvent) => Promise<Response> } {
	return {
		GET: async (e) => {
			const [app, ...frag] = (e.params.name ?? '').split(':');
			const cl = clients[app];
			const name = frag.join(':');
			if (!cl || frag.length === 0)
				return json_doc({ failed: true, reason: 'unknown fragment' }, 404);
			// allowlist gate: the browser chose `name` — a request outside the allowlist learns
			// nothing (same 404 as an unknown app, so probing can't enumerate the catalog)
			if (opts.widgets && !opts.widgets[app]?.includes(name))
				return json_doc({ failed: true, reason: 'unknown fragment' }, 404);
			const props: Record<string, string> = {};
			for (const [k, v] of e.url.searchParams) props[k] = v;
			try {
				const doc = await cl.widget(name, props, {
					claims: opts.user?.(e),
					traceparent: child_traceparent(e.request.headers.get('traceparent')).traceparent
				});
				return json_doc(doc);
			} catch (err) {
				return json_doc(
					{ failed: true, reason: err instanceof Error ? err.message : 'unreachable' },
					502
				);
			}
		}
	};
}
