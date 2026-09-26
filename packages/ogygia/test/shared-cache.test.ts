/**
 * HOLES ON A CACHED DOCUMENT (server/shared-cache.ts): a deferred hole's capability must outlive the
 * document a cache keeps. The mint reads the page's `cache-control` (noted by the handle from a
 * load's `setHeaders`) and signs anonymous holes for twice that shared-cache life; an already-expired
 * capability is renewable (by the endpoint, re-signed) within a window after its expiry; the runtime
 * tells an expired capability from its URL and retries it once with `&renew=1`.
 */
import { describe, expect, it } from 'vitest';
import {
	RENEW_WINDOW_SEC,
	document_shared_lifetime,
	mint_ttl_sec,
	note_cache_control,
	renewable_expiry,
	shared_cache_lifetime
} from '../src/server/shared-cache.js';
import { PRERENDER_REGION_TTL_SEC, capability_expiry } from '../src/server/endpoint.js';
import { capability_expired, renewal_url } from '../src/runtime/region-endpoint-url.js';

describe('shared_cache_lifetime: how long shared caches may serve the document', () => {
	it('s-maxage + stale-while-revalidate (the field header: 8 days)', () => {
		expect(shared_cache_lifetime('public, s-maxage=604800, stale-while-revalidate=86400')).toBe(691200);
	});
	it('s-maxage wins over max-age for shared caches', () => {
		expect(shared_cache_lifetime('max-age=60, s-maxage=3600')).toBe(3600);
	});
	it('max-age counts with or without `public` (a shared cache may store any non-private response)', () => {
		expect(shared_cache_lifetime('public, max-age=600')).toBe(600);
		expect(shared_cache_lifetime('max-age=600')).toBe(600);
	});
	it('private / no-store / no-cache: shared caches do not serve it → 0', () => {
		expect(shared_cache_lifetime('private, max-age=600')).toBe(0);
		expect(shared_cache_lifetime('no-store')).toBe(0);
		expect(shared_cache_lifetime('public, no-cache, s-maxage=600')).toBe(0);
		expect(shared_cache_lifetime('PUBLIC, S-MAXAGE=10, Private')).toBe(0);
	});
	it('stale-while-revalidate alone still keeps a stale copy in service', () => {
		expect(shared_cache_lifetime('s-maxage=0, stale-while-revalidate=120')).toBe(120);
	});
	it('stale-if-error does not count (the origin is failing: no hole renders anyway)', () => {
		expect(shared_cache_lifetime('s-maxage=60, stale-if-error=86400')).toBe(60);
	});
	it('case, spacing and quoted values are tolerated; junk values are ignored', () => {
		expect(shared_cache_lifetime(' Public ,S-MaxAge="300" ')).toBe(300);
		expect(shared_cache_lifetime('s-maxage=abc, max-age=-5, max-age=1e9')).toBe(0);
		expect(shared_cache_lifetime('')).toBe(0);
	});
});

describe('mint_ttl_sec: the capability lifetime a hole is signed for', () => {
	const region_ttl = 3600;
	it('a stored page (prerender / freeze) is prerender-grade, whatever else', () => {
		expect(mint_ttl_sec({ stored: true, session: 'abc', shared: 0, region_ttl })).toBe(PRERENDER_REGION_TTL_SEC);
	});
	it('an anonymous hole on a shared-cached document: twice the cache life', () => {
		const ttl = mint_ttl_sec({ stored: false, session: '', shared: 691200, region_ttl });
		expect(ttl).toBe(2 * 691200);
		// …so the window-aligned expiry covers the WHOLE cache life, from any minute of minting
		for (let now = 1_789_000_000; now < 1_789_000_000 + 3 * 691200; now += 9973)
			expect(capability_expiry(now, ttl) - now).toBeGreaterThanOrEqual(691200);
	});
	it('never shorter than regions.ttl, never longer than prerender-grade', () => {
		expect(mint_ttl_sec({ stored: false, session: '', shared: 60, region_ttl })).toBe(region_ttl);
		expect(mint_ttl_sec({ stored: false, session: '', shared: 1e10, region_ttl })).toBe(PRERENDER_REGION_TTL_SEC);
	});
	it('a session-bound hole is never extended (its document is the visitor’s own)', () => {
		expect(mint_ttl_sec({ stored: false, session: 'sess', shared: 691200, region_ttl })).toBe(region_ttl);
	});
	it('no shared-cache life (or unknown): regions.ttl, unchanged', () => {
		expect(mint_ttl_sec({ stored: false, session: '', shared: 0, region_ttl })).toBe(region_ttl);
	});
});

describe('renewable_expiry: the renewal gate’s time rule', () => {
	const now = 1_789_000_000;
	it('an expiry that HAS passed, within the window, renews', () => {
		expect(renewable_expiry(String(now - 1), now)).toBe(true);
		expect(renewable_expiry(String(now - RENEW_WINDOW_SEC), now)).toBe(true);
	});
	it('a capability that has not expired never renews', () => {
		expect(renewable_expiry(String(now), now)).toBe(false);
		expect(renewable_expiry(String(now + 60), now)).toBe(false);
	});
	it('past the window: refused (9 days back)', () => {
		expect(renewable_expiry(String(now - RENEW_WINDOW_SEC - 1), now)).toBe(false);
		expect(renewable_expiry(String(now - 9 * 24 * 3600), now)).toBe(false);
	});
	it('only a plain integer (no sign, fraction, exponent or padding)', () => {
		for (const bad of ['', '-1', '1.5', '1e9', ' 1', '0x10', '9'.repeat(13)]) expect(renewable_expiry(bad, now)).toBe(false);
	});
});

describe('the per-request seam', () => {
	it('the handle notes a request’s cache-control; the mint reads it for THAT request only', () => {
		const page = new Request('http://x/p');
		const other = new Request('http://x/q');
		note_cache_control(page, 'public, s-maxage=600');
		expect(document_shared_lifetime(page)).toBe(600);
		expect(document_shared_lifetime(other)).toBe(0);
		expect(document_shared_lifetime(null)).toBe(0);
	});
	it('lives on ONE globalThis slot, so every copy of the module shares it', () => {
		const slot = (globalThis as unknown as Record<symbol, { by_request: WeakMap<Request, number> }>)[
			Symbol.for('ogygia.shared-cache')
		];
		const r = new Request('http://x/r');
		slot.by_request.set(r, 42); // what another evaluation of the module would write
		expect(document_shared_lifetime(r)).toBe(42);
	});
});

describe('runtime: telling an expired capability from its URL', () => {
	const origin = 'http://x';
	const url = (exp: number) => `/__ogygia__?id=abcdefabcdef&props=W10&exp=${exp}&sig=00`;
	const now_ms = 1_789_000_000_000;
	it('a passed exp is expired', () => {
		expect(capability_expired(url(1_789_000_000 - 3600), now_ms, origin)).toBe(true);
	});
	it('a slow client clock (up to 5 min behind) still sees it', () => {
		expect(capability_expired(url(1_789_000_000 + 200), now_ms, origin)).toBe(true);
	});
	it('a live capability is not retried', () => {
		expect(capability_expired(url(1_789_000_000 + 3600), now_ms, origin)).toBe(false);
	});
	it('a URL without a usable exp is not retried', () => {
		expect(capability_expired('/__ogygia__?id=abcdefabcdef&sig=00', now_ms, origin)).toBe(false);
		expect(capability_expired('/__ogygia__?exp=soon', now_ms, origin)).toBe(false);
	});
	it('the renewal request is the same URL plus renew=1', () => {
		expect(renewal_url(url(5))).toBe(url(5) + '&renew=1');
	});
});
