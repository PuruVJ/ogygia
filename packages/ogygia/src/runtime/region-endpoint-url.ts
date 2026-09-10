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

/** Has this island module already been warmed (or imported through the warmer)? `entry` resolves
 *  the way `warm_island_module` resolves it; `base` for an href read off a foreign document. */
export function is_warmed_module(entry: string, base?: string): boolean {
	return warmed_modules.has(island_module_url(entry, base));
}

// ── the SSR's module-preload hints ─────────────────────────────────────────────
// Region.svelte emits a `<link rel="modulepreload">` (always background priority) for a `visible`
// island's full dep closure (prod). The idle warm must NOT `import()` a hinted module — that would
// escalate a still-queued hint fetch to High, the exact contention the hints exist to avoid. One
// page can carry ~180 hints and ~150 visible islands: resolving every hint's href per island was
// 27k `URL`s on a real page. The hint set is built ONCE per document, lazily, and dropped when the
// router prepares the next document (the merged head carries the next page's hints).
let hinted_modules: Set<string> | null = null;

/** Did the SSR ship a modulepreload hint for this island's module? */
export function is_hinted_module(entry: string): boolean {
	if (!hinted_modules) {
		hinted_modules = new Set();
		for (const l of document.querySelectorAll('link[rel="modulepreload"]')) {
			const href = l.getAttribute('href');
			if (!href) continue;
			try {
				hinted_modules.add(new URL(href, location.href).href);
			} catch {
				/* a malformed href hints nothing */
			}
		}
	}
	try {
		return hinted_modules.has(new URL(entry, location.href).href);
	} catch {
		return false; // URL parse hiccup — treat as unhinted; the idle import stays the byte layer
	}
}

/** Forget the hint set (the router, before a new document's body connects). */
export function invalidate_hint_set(): void {
	hinted_modules = null;
}
