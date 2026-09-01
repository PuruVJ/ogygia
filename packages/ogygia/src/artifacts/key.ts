/**
 * artifacts — keying. v1 keying law (internal/notes/artifact.md, RESTRUCTURE): the key IS the
 * URL pathname. Zero sources, zero markers; `invalidate(url)` is exact because a CMS publish
 * payload carries its urlPath, and bulk eviction is a key-prefix scan (`invalidateWhere({
 * prefix: '/fr/fr/' })` — locale nukes are one case of it, not the contract). Query-stringed
 * requests are never stored (a `?` is an unbounded personalization axis — utm, search,
 * pagination — v1 keeps the store bounded).
 */

/** The store key for a request URL: the decoded pathname, verbatim (trailing slash preserved —
 *  `/fr/fr/` and `/fr/fr` are different documents to Kit and to the CDN). */
export function artifact_key(pathname: string): string {
	return pathname;
}

/** How many leading path segments become edge prefix tags (`p:/fr`, `p:/fr/fr`, `p:/fr/fr/x`).
 *  Depth-capped so tag counts stay bounded on deep trees; a purge deeper than the cap falls back
 *  to origin eviction + edge TTL. Shared by the akamai adapter and its emulator personality. */
export const PREFIX_TAG_DEPTH = 3;

/** Normalize a prefix filter: leading slash enforced, trailing slash stripped (except root). */
export function normalize_prefix(prefix: string): string {
	let p = prefix.startsWith('/') ? prefix : '/' + prefix;
	while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
	return p;
}

/** The depth-capped prefix list for a pathname — the edge tag vocabulary for this response. */
export function prefix_tags(pathname: string): string[] {
	const segs = pathname.split('/').filter(Boolean);
	const out: string[] = [];
	for (let i = 1; i <= Math.min(segs.length, PREFIX_TAG_DEPTH); i++) {
		out.push('/' + segs.slice(0, i).join('/'));
	}
	return out;
}
