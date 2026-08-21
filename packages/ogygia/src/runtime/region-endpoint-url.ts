const ABSOLUTE_URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

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
	import(/* @vite-ignore */ url).catch(() => {
		warmed_modules.delete(url);
	});
}
