// Default server-island / region endpoint path. The double-underscore sentinel makes it clash-safe
// against real application routes (no app ships a `/__ogygia__` route) while staying plain ASCII —
// readable in the network panel, no percent-encoding on the wire. Overridable via
// `ogygiaHandle({ endpoint })`.
export const DEFAULT_ISLANDS_ENDPOINT = '/__ogygia__';

/**
 * THE ISLANDS ENDPOINT — one path for everything that names it: the handle answers on it, every
 * capability is minted against it, a render knows it is serving a hole by it, the profiler counts
 * its requests by it. `handle({ endpoint })` sets it as the app's hooks load, before any render
 * (Kit loads the server hooks before it renders anything, prerender included). It used to move only
 * the handler: pages still minted `/__ogygia__?…`, and behind a proxy that forwards only the app's
 * own prefixes every hole was empty.
 *
 * Process-wide on `globalThis`, not module state: this file can load under two module ids in one
 * server (the plugin points the mint at the package's built file while an app's hooks import it from
 * a linked package's source), and a module variable set by the handle was then never read by the mint.
 */
const ENDPOINT_KEY = Symbol.for('ogygia.islands-endpoint');
const endpoint_slot = globalThis as unknown as Record<symbol, string | undefined>;

/** The islands endpoint path (without the app's base: matched by suffix, minted through `resolve`). */
export function islands_endpoint(): string {
	return endpoint_slot[ENDPOINT_KEY] ?? DEFAULT_ISLANDS_ENDPOINT;
}

/** Set by the handle (`handle({ endpoint })`); the default when none is given. */
export function configure_islands_endpoint(path: string | undefined): void {
	// (the suffix match and the mint both read a leading slash: `api/x` would match `/myapi/x`)
	endpoint_slot[ENDPOINT_KEY] = !path
		? DEFAULT_ISLANDS_ENDPOINT
		: path.startsWith('/')
			? path
			: '/' + path;
}

/** Max b64url props blob accepted by the region handle (and refused at mint time). */
export const MAX_REGION_PROPS_LEN = 8192;

/**
 * Default capability TTL (seconds) for DYNAMIC pages. Shorter than a day so harvested URLs age
 * out; override via `ogygia({ ttl })`.
 */
export const DEFAULT_REGION_TTL_SEC = 3600;

/**
 * Capability TTL for PRERENDERED pages (10 years — effectively the life of the deploy). A static
 * file lives on the CDN indefinitely, so an aging capability would strand every hole on it after
 * `ttl` (real PPR would silently die in an hour). Safe: the capability's props are already
 * baked into the public static HTML, and the mint seals an EMPTY session at prerender — signing
 * that same public tuple for longer reveals nothing new. Redeploy survival additionally needs a
 * stable `OGYGIA_SECRET` (the default per-build key rotates; ServerIsland warns at build).
 */
export const PRERENDER_REGION_TTL_SEC: number = 10 * 365 * 24 * 3600;

/**
 * WHEN a capability minted now expires — aligned to a window, not `now + ttl`.
 *
 * Every render of the same hole (same id, props, session) in the same window mints the SAME
 * `exp`, hence the SAME signature and URL: the hole's HTML is byte-identical across requests. That
 * is what lets anything keyed on the page's bytes hit — a host app's post-render component cache,
 * a CDN or freeze store comparing documents, an ETag. With `now + ttl` every request minted a new
 * URL and a header block wrapping five holes was re-processed on every request (measured: seconds
 * of server time per page on a Lambda-class host).
 *
 * The window is half the TTL: `exp` is the end of the window after the current one, so a
 * capability is always valid for at least `ttl / 2` and at most `ttl` (harvested URLs still age
 * out on the same order); consecutive windows overlap by construction, so a page rendered at the
 * end of a window and fetched a moment later still verifies.
 */
export function capability_expiry(now_sec: number, ttl_sec: number): number {
	const half = Math.max(1, Math.floor(ttl_sec / 2));
	return (Math.floor(now_sec / half) + 2) * half;
}

/** Region ids are always 12 lowercase hex chars from the transform. */
export const REGION_ID_RE: RegExp = /^[0-9a-f]{12}$/;

/**
 * A hole's optional cache `ttl` (max-age seconds) as it rides in the endpoint URL: empty (no-store,
 * the default) or 1–7 digits (up to ~115 days). Charset-gated before HMAC so a forged value can't
 * reach the response header, though the MAC is the real guard.
 */
export const REGION_TTL_RE: RegExp = /^(|[0-9]{1,7})$/;

// The per-request gates, as char loops (measured ~2× the anchored patterns above, which stay the
// documented shape): every hole request runs both before its HMAC.

/** {@link REGION_ID_RE}: exactly 12 lowercase hex chars. */
export function is_region_id(s: string): boolean {
	return is_lower_hex(s, 12);
}

/** {@link REGION_TTL_RE}: empty, or 1–7 ASCII digits. */
export function is_region_ttl(s: string): boolean {
	if (s.length > 7) return false;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 48 || c > 57) return false;
	}
	return true;
}

/** Exactly `n` chars of `[0-9a-f]`. */
export function is_lower_hex(s: string, n: number): boolean {
	if (s.length !== n) return false;
	for (let i = 0; i < n; i++) {
		const c = s.charCodeAt(i);
		if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
	}
	return true;
}
