/**
 * `capability_expiry` — a hole's capability expires at a WINDOW boundary, not `now + ttl`, so every
 * render of the same hole in the same window mints the same URL (byte-identical HTML across
 * requests: a host's post-render cache, a freeze store, an ETag can all hit). Validity stays
 * bounded: at least ttl/2, at most ttl.
 */
import { describe, expect, it } from 'vitest';
import { capability_expiry, PRERENDER_REGION_TTL_SEC } from '../src/server/endpoint.js';

describe('capability_expiry', () => {
	const ttl = 3600;

	it('is identical for every second of the same half-TTL window', () => {
		const start = 1_789_000_000 - (1_789_000_000 % 1800); // a window start
		const exps = new Set<number>();
		for (let s = start; s < start + 1800; s += 97) exps.add(capability_expiry(s, ttl));
		expect(exps.size).toBe(1);
		// the next window mints a different (later) expiry
		expect(capability_expiry(start + 1800, ttl)).toBeGreaterThan([...exps][0]);
	});

	it('is always valid for more than ttl/2 and at most ttl', () => {
		for (let now = 1_789_000_000; now < 1_789_000_000 + 4 * ttl; now += 53) {
			const left = capability_expiry(now, ttl) - now;
			expect(left).toBeGreaterThan(ttl / 2);
			expect(left).toBeLessThanOrEqual(ttl);
		}
	});

	it('never goes backwards as time moves forward', () => {
		let prev = 0;
		for (let now = 1_789_000_000; now < 1_789_000_000 + 3 * ttl; now += 7) {
			const e = capability_expiry(now, ttl);
			expect(e).toBeGreaterThanOrEqual(prev);
			prev = e;
		}
	});

	it('a 1-second TTL still works (window floor of 1 s)', () => {
		expect(capability_expiry(100, 1)).toBe(102);
	});

	it('the prerender TTL stays effectively forever', () => {
		const e = capability_expiry(1_789_000_000, PRERENDER_REGION_TTL_SEC);
		expect(e - 1_789_000_000).toBeGreaterThan(PRERENDER_REGION_TTL_SEC / 2);
	});
});
