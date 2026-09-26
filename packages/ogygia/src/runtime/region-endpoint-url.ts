import { preload_island_graph } from './island-graph-preload.js';

/** Hoisted (hot paths — connectedCallback/hydrate run per region); shared with core's
 *  foreign-origin checks. */
export const ABSOLUTE_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Defense-in-depth: only fetch region HTML from same-origin capability URLs.
 * Mint always emits a path-only URL (`resolve(DEFAULT_ISLANDS_ENDPOINT)?…`). Absolute /
 * protocol-relative endpoints would require prior HTML injection — still reject them so the
 * runtime is not an XSS amplifier. See INVARIANTS.md · HOLE-TRUST.
 */

/** True when `endpoint` resolves to same-origin http(s). */
export function is_allowed_region_endpoint(
	endpoint: string,
	page_origin = location.origin
): boolean {
	if (typeof endpoint !== 'string' || endpoint.length === 0) return false;
	try {
		const url = new URL(endpoint, page_origin);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
		if (url.origin !== page_origin) return false;
		// Reject if the final response could redirect cross-origin — checked by caller via res.url.
		return true;
	} catch {
		return false;
	}
}

/** How far this browser's clock may run behind the server's and still see an expiry. */
const CLOCK_SKEW_SEC = 300;

/**
 * Has this hole's capability (probably) EXPIRED — worth one retry with `&renew=1` after a 403? Its
 * document outlived it in a cache (server/shared-cache.ts). Read from the signed `exp` in the URL,
 * with {@link CLOCK_SKEW_SEC} of slack for a slow clock; a URL that has not expired never renews
 * (the server refuses it), so a wrong guess costs one refused request.
 */
export function capability_expired(endpoint: string, now_ms = Date.now(), page_origin = location.origin): boolean {
	try {
		const exp = Number(new URL(endpoint, page_origin).searchParams.get('exp'));
		return Number.isFinite(exp) && exp > 0 && exp <= now_ms / 1000 + CLOCK_SKEW_SEC;
	} catch {
		return false;
	}
}

/** The renewal request for an expired capability `endpoint` (the handle re-signs it, anonymous
 *  holes only, and answers the fresh capability in `x-ogygia-capability`). */
export function renewal_url(endpoint: string): string {
	return endpoint + (endpoint.includes('?') ? '&' : '?') + 'renew=1';
}

/** A whole HTML document starts with a doctype or `<html>`; a region answer never does. */
const DOCUMENT_START_RE = /^\s*(?:<!doctype\b|<html\b)/i;

/**
 * Is this hole answer a WHOLE DOCUMENT rather than the region's fragment? ogygia's handle answers a
 * region request in place — a fragment, a 204, an error status — never with a page. A page here
 * means a handle in front of `ogygia.handle()` took the request instead (an auth wall, a locale
 * bounce, a 404 handler) and the browser followed it: a customer's signed-in visitors had every
 * hole of the header filled with the account area's page — its scripts, its skeletons, a second
 * header. Refused, the fallback stands; the redirect twin is {@link is_redirected_answer}.
 */
export function is_document_answer(text: string): boolean {
	return DOCUMENT_START_RE.test(text.slice(0, 256));
}

/** A region request that was redirected (same origin — cross-origin is refused earlier) did not
 *  reach the endpoint it named: whatever answered is not the region. */
export function is_redirected_answer(res: Response): boolean {
	return res.redirected === true;
}

/** The error a refused answer throws: the fetch loop does not retry it (the answer is
 *  deterministic — a redirect rule, not a flaky network) and DEV names the culprit. */
export class RegionAnswerRefused extends Error {
	override name = 'RegionAnswerRefused';
	constructor(
		public readonly reason: 'redirected' | 'document',
		public readonly final_url: string
	) {
		super(`region answer refused: ${reason} (${final_url})`);
	}
}

/** After fetch: reject opaque redirects that left the page origin. */
export function is_same_origin_response(res: Response, page_origin = location.origin): boolean {
	if (!res.url) return true; // older environments — rely on request URL check
	try {
		return new URL(res.url).origin === page_origin;
	} catch {
		return false;
	}
}

/**
 * Normalize a hydrate `entry` for `import()`.
 *
 * Root-absolute paths (`/@id/…`, `/_app/…`) and absolute URLs import as-is. Relative specs
 * (`./_app/…`, `../_app/…`) must resolve against the **document** URL — `import()` would
 * otherwise resolve them against the runtime module (`/_app/immutable/og-runtime.*`)
 * and produce `/_app/_app/…` 404s on nested routes.
 */
export function island_module_url(entry: string, base?: string): string {
	if (!entry) return entry;
	if (entry.startsWith('/') || ABSOLUTE_URL_SCHEME.test(entry)) return entry;
	const resolved = new URL(entry, base ?? location.href);
	return resolved.pathname + resolved.search + resolved.hash;
}

// ── the ONE island-module warmer ─────────────────────────────────────────────
// Every "get this island's JS into the module cache before it's needed" call site funnels here:
// the router's next-page prefetch warm, core's visible-island idle warm, and the interaction
// feature's pointerenter warm. One URL-level dedupe set replaces three inconsistent schemes
// (`import()` is idempotent, but re-parsing the specifier on every hover isn't free). A failed
// warm un-marks the URL so the real wake — or a later warm — retries; warming is never fatal.
const warmed_modules = new Set<string>();

/** Fire-and-forget `import()` of an island's module, deduped by resolved URL. */
export function warm_island_module(entry: string, base?: string): void {
	const url = island_module_url(entry, base);
	if (!url || warmed_modules.has(url)) return;
	warmed_modules.add(url);
	preload_island_graph(entry, base); // the whole graph with the entry, not one import at a time
	import(/* @vite-ignore */ url).catch(() => {
		warmed_modules.delete(url);
	});
}

/** Has this island module already been warmed (or imported through the warmer)? `entry` resolves
 *  the way `warm_island_module` resolves it; `base` for an href read off a foreign document. */
export function is_warmed_module(entry: string, base?: string): boolean {
	return warmed_modules.has(island_module_url(entry, base));
}
