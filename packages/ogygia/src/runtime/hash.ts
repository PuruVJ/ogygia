/**
 * Region fingerprint — the PURE core (no DOM, no imports) shared by the client reconciler AND the
 * server (Region.svelte, server-delta nav). Kept dependency-free so it is safe in BOTH bundles and
 * so client↔server fingerprints are IDENTICAL BY CONSTRUCTION: the server emits `data-og-fp =
 * fingerprint_of(entry, '', props_payload)` on each island, and the client's `region_props_fp`
 * reads the same entry attribute + '' endpoint + props-script text → the same hash. That parity is
 * what makes server-delta nav safe (the server skips exactly the regions the client says it has).
 *
 *   • signature   — WHICH region slot (entry + the endpoint's stable id/props, minus exp/sig).
 *   • fingerprint — DID ITS INPUTS CHANGE (hash of entry + endpoint + the props seed).
 */

/** 64-bit fingerprint over a string → 16-char hex. Two independent 32-bit lanes (FNV-1a-32 and an
 *  FNV-style lane with murmur's mixing constant + an xorshift), concatenated. 64 bits on purpose:
 *  the server-delta SKIPS a region on a fingerprint match, so a collision would keep stale/wrong
 *  content silently — 64 bits makes that a non-risk on any real page. NOT canonical FNV-1a-64: the
 *  previous BigInt implementation cost 20 ms per island on a CMS page whose props run to 480 KB
 *  (one BigInt allocation per character — 0.4 s of a 3.7 s server render, seen in the profiler);
 *  this loop is pure int32 arithmetic and hashes the same page in about a millisecond. Parity is by
 *  construction — the same function runs on both legs — so the algorithm is free to change. */
export function fnv1a(s: string): string {
	let a = 0x811c9dc5;
	let b = 0x811c9dc5 ^ 0x9e3779b9;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		a ^= c;
		a = Math.imul(a, 0x01000193);
		b ^= c;
		b = Math.imul(b, 0x27d4eb2f);
		b ^= b >>> 15;
	}
	return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** FNV-1a 32-bit over a string → uint32. The NUMERIC sibling for callers that bucket/mod rather
 *  than compare (experiment splits, build-cache keys) — no BigInt, no hex round-trip. This is THE
 *  one shared implementation; the driver/vite copies were folded into it. */
export function fnv1a32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * The stable part of a signed endpoint URL: everything up to the volatile `&exp=…&sig=…` tail.
 * A deferred region's endpoint encodes `?id=…&props=…&exp=…&sig=…`; exp/sig rotate per render, so
 * they must NOT enter identity or two renders of the same region would never match. Returns the
 * `id`+`props` portion; empty string when there is no endpoint.
 */
export function endpoint_key(endpoint: string): string {
	if (!endpoint) return '';
	const exp = endpoint.indexOf('&exp=');
	return exp === -1 ? endpoint : endpoint.slice(0, exp);
}

/** Match key: WHICH region slot this is (testable without a DOM). */
export function signature_of(entry: string, endpoint: string): string {
	return entry + ' ' + endpoint_key(endpoint);
}

/** Change key: DID this region's inputs change (testable without a DOM). */
export function fingerprint_of(entry: string, endpoint: string, props_text: string): string {
	return fnv1a(entry + ' ' + endpoint_key(endpoint) + ' ' + props_text);
}
