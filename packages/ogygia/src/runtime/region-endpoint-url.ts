/**
 * Defense-in-depth: only fetch region HTML from same-origin capability URLs.
 * Mint always emits a path-only URL (`resolve(DEFAULT_ISLANDS_ENDPOINT)?…`). Absolute /
 * protocol-relative endpoints would require prior HTML injection — still reject them so the
 * runtime is not an XSS amplifier. See INVARIANTS.md · HOLE-TRUST.
 */

/** True when `endpoint` resolves to same-origin http(s). */
export function is_allowed_region_endpoint(endpoint: string, page_origin = location.origin): boolean {
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
