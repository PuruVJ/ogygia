/**
 * HOLES ON A CACHED DOCUMENT — a deferred hole's capability must outlive the document it sits in.
 *
 * A page whose load says `cache-control: public, s-maxage=604800` is served from a CDN for a week,
 * but its holes were minted for `regions.ttl` (an hour by default, capped at a day): once that passed,
 * every visitor served the cached copy got a 403 for every hole, and nothing logged it. Prerender
 * already solves the same problem by signing for the life of the deploy; this is the request-time
 * equivalent, bounded by what the app itself declared.
 *
 * 1. The handle notes the `cache-control` a load sets (`setHeaders`) on the page request; the mint
 *    reads it and signs an ANONYMOUS hole for twice that lifetime (`capability_expiry` guarantees
 *    only half of a ttl). Same safety argument as prerender: the props are already in the public
 *    HTML, and nothing session-bound is extended.
 * 2. A document already cached with short-lived holes (or one whose cache header a handle set after
 *    the render, where the mint cannot see it) is rescued by RENEWAL: the runtime retries an expired
 *    hole once with `&renew=1`, and the handle re-signs a capability it minted itself, anonymous,
 *    expired by at most {@link RENEW_WINDOW_SEC}.
 *
 * State rides ONE `globalThis` + `Symbol.for` slot (the PAGE-STATE-SINGLETON law): the handle
 * (hooks.js) records and the mint (server/region-endpoint.js) reads, and dist entries can each carry
 * their own evaluation of this module — a module-local map would split the seam.
 */
import { PRERENDER_REGION_TTL_SEC } from './endpoint.js';

/** How long after expiry a capability can still be renewed: the longest a stale document is
 *  expected to live in a shared cache (a week of `s-maxage` plus a day of revalidation). */
export const RENEW_WINDOW_SEC = 8 * 24 * 3600;

/**
 * How long shared caches may serve a document with this `cache-control`, in seconds: its freshness
 * (`s-maxage`, else `max-age`) plus `stale-while-revalidate`. 0 when shared caches may not keep it
 * (`private`, `no-store`) or must revalidate every use (`no-cache`). `max-age` counts without
 * `public`: a shared cache may store any response not marked `private` (RFC 9111 §3).
 * `stale-if-error` does not count: it serves a stale copy only while the origin is failing, when a
 * hole could not render anyway.
 */
export function shared_cache_lifetime(cache_control: string): number {
	let s_maxage = -1;
	let max_age = -1;
	let swr = 0;
	for (const part of cache_control.toLowerCase().split(',')) {
		const eq = part.indexOf('=');
		const name = (eq === -1 ? part : part.slice(0, eq)).trim();
		if (name === 'private' || name === 'no-store' || name === 'no-cache') return 0;
		if (eq === -1) continue;
		const n = seconds(part.slice(eq + 1));
		if (n === null) continue;
		if (name === 's-maxage') s_maxage = n;
		else if (name === 'max-age') max_age = n;
		else if (name === 'stale-while-revalidate') swr = n;
	}
	const fresh = s_maxage >= 0 ? s_maxage : max_age >= 0 ? max_age : 0;
	return fresh + swr;
}

/** A delta-seconds value (optionally quoted), or null. */
function seconds(raw: string): number | null {
	let v = raw.trim();
	if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
	if (v === '' || v.length > 10) return null;
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i);
		if (c < 48 || c > 57) return null;
	}
	return Number(v);
}

/**
 * The capability lifetime to mint with: prerender-grade for a stored page (prerender / freeze);
 * for an anonymous hole on a document shared caches keep for `shared` seconds, twice that (so the
 * window-aligned expiry still covers the whole cache life), capped at prerender-grade; else
 * `regions.ttl`. A session-bound hole is never extended — its document is the visitor's own.
 */
export function mint_ttl_sec(o: { stored: boolean; session: string; shared: number; region_ttl: number }): number {
	if (o.stored) return PRERENDER_REGION_TTL_SEC;
	if (o.session !== '' || o.shared <= 0) return o.region_ttl;
	return Math.min(PRERENDER_REGION_TTL_SEC, Math.max(o.region_ttl, 2 * o.shared));
}

/** A renewable expiry: an integer that HAS passed, by at most {@link RENEW_WINDOW_SEC}. */
export function renewable_expiry(exp_raw: string, now_sec: number): boolean {
	if (exp_raw === '' || exp_raw.length > 12) return false;
	for (let i = 0; i < exp_raw.length; i++) {
		const c = exp_raw.charCodeAt(i);
		if (c < 48 || c > 57) return false;
	}
	const exp = Number(exp_raw);
	return exp < now_sec && now_sec - exp <= RENEW_WINDOW_SEC;
}

// ── the per-request seam ─────────────────────────────────────────────────────────────────────────
interface Slot {
	by_request: WeakMap<Request, number>;
}
const SLOT_KEY = Symbol.for('ogygia.shared-cache');
const slot: Slot = ((globalThis as unknown as Record<symbol, Slot>)[SLOT_KEY] ??= {
	by_request: new WeakMap()
});

/** The handle: a load set `cache-control` on this page request. */
export function note_cache_control(request: Request, cache_control: string): void {
	slot.by_request.set(request, shared_cache_lifetime(cache_control));
}

/** The mint: how long shared caches keep the document this request renders (0 = unknown / none). */
export function document_shared_lifetime(request: Request | null | undefined): number {
	return request ? (slot.by_request.get(request) ?? 0) : 0;
}
