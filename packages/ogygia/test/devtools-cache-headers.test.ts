/**
 * HOW THE HOST CACHES THE CONTENT-NAMED FILES (devtools/cache-headers.ts): an island's file and the
 * runtime are named by their content, so a year-long `immutable` cache is right for them. A host that
 * sends `no-cache`, or a short `max-age`, makes returning visitors download them again.
 */
import { describe, it, expect } from 'vitest';
import { cached_long, cache_findings } from '../src/devtools/cache-headers.js';

describe('cached_long: does this cache-control keep the file long enough', () => {
	it('what SvelteKit sends, and other long policies', () => {
		expect(cached_long('public,max-age=31536000,immutable')).toBe(true);
		expect(cached_long('public, max-age=31536000, immutable')).toBe(true);
		expect(cached_long('max-age=86400')).toBe(true);
		expect(cached_long('private, max-age=604800')).toBe(true);
		expect(cached_long('Public, Max-Age=31536000, Immutable')).toBe(true);
		// immutable without a max-age: kept (a browser caches it as long as it may)
		expect(cached_long('public, immutable')).toBe(true);
	});
	it('what makes a returning visitor fetch again', () => {
		expect(cached_long(null)).toBe(false);
		expect(cached_long('')).toBe(false);
		expect(cached_long('no-cache')).toBe(false);
		expect(cached_long('no-store')).toBe(false);
		expect(cached_long('public, max-age=0, must-revalidate')).toBe(false);
		expect(cached_long('max-age=3600')).toBe(false);
		expect(cached_long('public, max-age=31536000, no-cache')).toBe(false);
		// immutable with max-age=0 is still "fetch again"
		expect(cached_long('max-age=0, immutable')).toBe(false);
		expect(cached_long('max-age=nonsense')).toBe(false);
	});
});

describe('cache_findings', () => {
	const probe = (name: string, cache_control: string | null, bytes = 2048) => ({ url: `https://a.test/_app/immutable/${name}.Hh12Kk34.js`, name, cache_control, bytes });

	it('files not cached long: named, with the header seen, the bytes, and the fix', () => {
		const f = cache_findings([probe('Probe', 'no-cache'), probe('Twin', 'no-cache', 1024), probe('Steady', 'public, max-age=31536000, immutable'), probe('the runtime', 'no-cache', 10240)]);
		expect(f).toHaveLength(1);
		expect(f[0].code).toBe('island-files-uncached');
		expect(f[0].severity).toBe('warn');
		expect(f[0].message).toContain('3 of the page');
		// heaviest first
		expect(f[0].message).toContain('the runtime, Probe, Twin');
		expect(f[0].message).not.toContain('Steady');
		expect(f[0].message).toContain('`no-cache`');
		expect(f[0].message).toContain('13.0 KB');
		expect(f[0].fix).toContain('public, max-age=31536000, immutable');
	});
	it('many files: the heaviest four are named, the rest counted', () => {
		const f = cache_findings([probe('Small', 'no-cache', 100), probe('Big', 'no-cache', 90_000), probe('Tiny', 'no-cache', 10), probe('Mid', 'no-cache', 5000), probe('the runtime', 'no-cache', 20_000)]);
		expect(f[0].message).toContain('Big, the runtime, Mid, Small and 1 more');
		expect(f[0].message).not.toContain('Tiny');
	});
	it('a missing header is named as such; many files are cut to four names', () => {
		const f = cache_findings(['A', 'B', 'C', 'D', 'E', 'F'].map((n) => probe(n, null, 0)));
		expect(f[0].message).toContain('`no cache-control`');
		expect(f[0].message).toContain('A, B, C, D and 2 more');
		expect(f[0].message).not.toContain('KB');
	});
	it('every file cached for good, or none probed: quiet', () => {
		expect(cache_findings([probe('Probe', 'public,max-age=31536000,immutable')])).toEqual([]);
		expect(cache_findings([])).toEqual([]);
	});
});
