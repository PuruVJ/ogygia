/**
 * federation — the wire: Ed25519 caller signing + verification (audience-bound, nonce'd,
 * replay-guarded), signature-bound visitor claims, W3C trace continuity, the fragment document
 * shapes, and the asset absolutizer. Design: internal/notes/federation.md.
 */
import {
	createPrivateKey,
	createPublicKey,
	createHash,
	randomBytes,
	sign as ed_sign,
	verify as ed_verify
} from 'node:crypto';

// ── paths the handle serves ──────────────────────────────────────────────────────────────────
/** The exposed route table: `GET|POST|… /og/fragment/page?path=…&search=…`. */
export const FRAGMENT_ROUTES_PATH = '/og/fragment/page';
/** Widgets: `GET /og/fragment/<name>?<props>`; `__catalog` = the unsigned manifest. */
export const FRAGMENT_BASE = '/og/fragment/';
/** Thaw notices: `POST /og/thaw` (signed, JSON `{ id, hop, build, tags }`). */
export const THAW_PATH = '/og/thaw';

// ── headers ──────────────────────────────────────────────────────────────────────────────────
const SIG_HEADER = 'x-og-sig';
const TS_HEADER = 'x-og-ts';
const USER_HEADER = 'x-og-user';
const NONCE_HEADER = 'x-og-n';
export const DEFAULT_SKEW_MS = 120_000;
/** Default cap on a forwarded fragment/notice body (form posts are small; 1 MiB is generous). */
export const DEFAULT_MAX_BODY = 1024 * 1024;

// ── replay defense ───────────────────────────────────────────────────────────────────────────
// A signature is unique per (key, payload) and the payload carries `ts`, so a byte-identical
// REPLAY reuses the same signature — reject one already seen inside its freshness window. Only
// VERIFIED signatures are recorded (an attacker can't grow this without the private key); expired
// entries sweep on write, so the map stays bounded to (legit rate × window). Process-local by
// design: audience binding is the cross-instance guarantee, this is the same-instance backstop.
const seen_sigs = new Map<string, number>();
const MAX_SEEN_SIGS = 100_000;
function replay_seen(sig: string, expires_at: number, now: number): boolean {
	if (seen_sigs.size > 0) {
		for (const [k, exp] of seen_sigs) {
			if (exp <= now) seen_sigs.delete(k);
			else break; // insertion order ≈ expiry order (uniform window) — stop at the first live one
		}
	}
	if (seen_sigs.has(sig)) return true;
	if (seen_sigs.size >= MAX_SEEN_SIGS) {
		for (const [k, exp] of seen_sigs) if (exp <= now) seen_sigs.delete(k);
		while (seen_sigs.size >= MAX_SEEN_SIGS) {
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
 *  caller cannot set a JS symbol, so an app's standalone (unsigned) front door can never smuggle
 *  identity in through a header. */
const CLAIMS = Symbol.for('ogygia.claims.v1');

/** Read the VERIFIED visitor claims in any load / action / endpoint of an exposed router (and in
 *  a widget's `info.user`). `undefined` on the standalone front door and for anonymous calls. */
export function user<T extends Claims = Claims>(c: { request: Request }): T | undefined {
	return (c.request as unknown as Record<symbol, T | undefined>)[CLAIMS];
}

/** Attach verified claims to a forwarded request (in-process, Symbol-keyed). */
export function attach_claims(request: Request, claims: Claims | undefined): void {
	if (claims) (request as unknown as Record<symbol, Claims>)[CLAIMS] = claims;
}

const body_hash = (body?: ArrayBuffer | Uint8Array | null) =>
	createHash('sha256')
		.update(body ? new Uint8Array(body as ArrayBuffer) : new Uint8Array(0))
		.digest('base64');

// ── KeyObject caches ─────────────────────────────────────────────────────────────────────────
// DER parsing dominates the crypto (sign ~48μs fresh vs ~17μs cached). Keys are few and static,
// so cache parsed KeyObjects by their base64 string, hard-capped as a safety valve.
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

// The signed payload binds the AUDIENCE (the target host) so a hop signed for one peer cannot be
// replayed at a sibling that trusts the same key. The NONCE makes every signature unique:
// Ed25519 is deterministic, so two identical concurrent requests would otherwise collide with
// the replay guard.
const sig_payload = (
	ts: string,
	method: string,
	pathq: string,
	bhash: string,
	claims: string,
	aud: string,
	nonce: string
) => Buffer.from(`${ts}.${method.toUpperCase()}.${pathq}.${bhash}.${claims}.${aud}.${nonce}`);

/** Caller side: headers proving "the holder of this private key sent EXACTLY this request, to
 *  THIS audience, now". `audience` defaults to the target URL's host. */
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
	/** base64 SPKI DER Ed25519 public keys of AUTHORIZED callers (a list = rotation overlap). */
	publicKeys: readonly string[];
	/** Max clock skew / replay window in ms (default 120s). */
	skewMs?: number;
	/** The audience(s) THIS app answers to. Defaults to the request URL's host. */
	audience?: string | string[];
}

/** Receiver side: fresh, valid, non-replayed signature from an authorized caller, bound to THIS
 *  audience? Returns the (signature-bound) visitor claims on success, `null` on any failure. */
export function verify_signed_request(
	cfg: VerifyConfig,
	request: Request,
	url: URL,
	body?: ArrayBuffer | Uint8Array | null
): { user?: Claims } | null {
	const ts = request.headers.get(TS_HEADER);
	const sig = request.headers.get(SIG_HEADER);
	if (!ts || !sig) return null;
	const ts_n = Number(ts);
	const skew = cfg.skewMs ?? DEFAULT_SKEW_MS;
	const now = Date.now();
	// a non-numeric ts → NaN; guard it, else `NaN > window` is false and the freshness gate opens
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

/** The raw claims header name — stripped from forwarded requests so nothing downstream can
 *  mistake an unverified header for identity. */
export const USER_HEADER_NAME = USER_HEADER;

// ── documents ────────────────────────────────────────────────────────────────────────────────
/** The wire document an exposed route table answers with. */
export interface FragmentDocument {
	status: number;
	/** 3xx target (already in the answering app's OWN base space, e.g. `/cms/posts/1`). */
	location?: string;
	title: string;
	/** `<link rel="stylesheet">` / `<style>` tags, asset hrefs absolute to the answering origin. */
	css: string[];
	/** HEAD CHANNEL: the page's SEO/social head bits (`<meta>` + canonical links; never
	 *  charset/viewport/http-equiv — those are the shell's). */
	head?: string;
	body: string;
	/** Absolute URL of the answering app's OWN ogygia runtime (a foreign host loads it to wake
	 *  the fragment's islands). */
	runtime?: string;
	/** The answering app's OWN canonical pathname for this page (`base + path`) — the shell files
	 *  its frozen page under `p:<peer>:<path>`, so `freeze.invalidate('<path>')` on the peer thaws
	 *  it (see internal/notes/federation.md §3–4). */
	path?: string;
	/** PROVENANCE: the receipt tags this render consumed — its own `s:<id>:<fp>` (og.source) plus
	 *  any `r:…`/`p:…`/`a:…` it adopted from ITS peers (a chain). The consumer prefixes each with
	 *  this peer's name and files its frozen page under them. */
	sources?: string[];
	/** The answering app's build id — changes per deploy. */
	build?: string;
	/** OBSERVABILITY: the trace this render belonged to + how long it took. */
	trace?: { trace_id: string; span_id: string };
	server_ms?: number;
}

/** What a named widget (`/og/fragment/<name>`) answers with. */
export interface WidgetDocument {
	html: string;
	origin?: string;
	sources?: string[];
	build?: string;
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

// ── asset absolutizing ───────────────────────────────────────────────────────────────────────
const ABSOLUTE_RE = /^[a-z][a-z0-9+.-]*:|^\/\//i;
const ASSET_ATTR_RE = /\b(entry|endpoint|href|src)="([^"]+)"/g;
const ASSET_PATH_RE = /(?:^|\/)(_app|og)\//;
const ASSET_EXT_RE = /\.(js|css|woff2?)(\?|$)/;

/** Pin ASSET refs (island entries, stylesheets, chunks) to `origin`; app-local LINKS stay
 *  path-relative — the consuming shell owns the address space they resolve in. */
export function absolutize(html: string, origin: string): string {
	return html.replace(ASSET_ATTR_RE, (_m, attr: string, value: string) => {
		if (ABSOLUTE_RE.test(value)) return `${attr}="${value}"`;
		if (!ASSET_PATH_RE.test(value) && !ASSET_EXT_RE.test(value)) return `${attr}="${value}"`;
		return `${attr}="${new URL(value, origin + '/').href}"`;
	});
}

// ── document lifting (an app's full HTML → the wire document) ────────────────────────────────
const HEAD_RE = /<head[^>]*>([\s\S]*?)<\/head>/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const STYLESHEET_LINK_RE = /<link\b[^>]*rel="stylesheet"[^>]*>/gi;
const STYLE_TAG_RE = /<style[\s\S]*?<\/style>/gi;
const BODY_RE = /<body[^>]*>([\s\S]*)<\/body>/i;
const RUNTIME_SCRIPT_RE = /<script[^>]*data-ogygia-runtime[^>]*src="([^"]+)"/i;
// HEAD CHANNEL: the meta tags worth carrying (SEO/social); charset/viewport/http-equiv stay the
// shell's — it owns the document.
const META_TAG_RE = /<meta\b[^>]*>|<link\b[^>]*rel="canonical"[^>]*>/gi;
const SHELL_OWNED_META_RE = /\bcharset\b|http-equiv|name="viewport"/i;

/** Lift a full HTML document into the wire shape (title, css, head channel, body, runtime). */
export function lift_document(html: string, origin: string): Omit<FragmentDocument, 'status'> {
	const head = html.match(HEAD_RE)?.[1] ?? '';
	const runtime_src = html.match(RUNTIME_SCRIPT_RE)?.[1];
	const head_meta = (head.match(META_TAG_RE) ?? [])
		.filter((t) => !SHELL_OWNED_META_RE.test(t))
		.map((t) => absolutize(t, origin))
		.join('');
	return {
		title: head.match(TITLE_RE)?.[1] ?? '',
		css: [...(head.match(STYLESHEET_LINK_RE) ?? []), ...(head.match(STYLE_TAG_RE) ?? [])].map((t) =>
			absolutize(t, origin)
		),
		...(head_meta ? { head: head_meta } : {}),
		body: absolutize(html.match(BODY_RE)?.[1] ?? html, origin),
		...(runtime_src ? { runtime: new URL(runtime_src, origin + '/').href } : {})
	};
}

// ── JSON responses ───────────────────────────────────────────────────────────────────────────
export const json_response = (data: unknown, status = 200, extra?: Record<string, string>) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', ...extra }
	});

export const json_error = (status: number, error: string) =>
	json_response({ error, status }, status);

/** Read a request body under a cap BEFORE any verification work (an unauthenticated caller must
 *  never stream gigabytes into this process). Returns `null` when over the cap. */
export async function read_capped_body(
	request: Request,
	max: number
): Promise<ArrayBuffer | undefined | null> {
	if (request.method === 'GET' || request.method === 'HEAD') return undefined;
	const cl = Number(request.headers.get('content-length'));
	if (Number.isFinite(cl) && cl > max) return null;
	const body = await request.arrayBuffer();
	return body.byteLength > max ? null : body;
}
