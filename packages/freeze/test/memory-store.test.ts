/**
 * The tier-1 memory store is bounded by BYTES first, entries second (a stored page can be multi-MB;
 * a count alone bounds nothing).
 */
import { describe, it, expect } from 'vitest';
import { memory_store } from '../src/memory-store.ts';

describe('freeze memory store is byte-bounded', () => {
	it('a run of multi-MB pages stays under the budget; the newest survive', async () => {
		const store = memory_store(1000, 5_000_000);
		const html = '<html>' + 'y'.repeat(2_000_000) + '</html>';
		for (let i = 0; i < 6; i++) {
			await store.put(`/p${i}/`, { kind: 'page', html, headers: {}, created: 0 }, { ttl: 60 });
		}
		expect(await store.size!()).toBe(2);
		expect(await store.get('/p5/')).not.toBeNull();
		expect(await store.get('/p0/')).toBeNull();
	});

	it('redirects are cheap entries: a thousand of them fit', async () => {
		const store = memory_store(1000, 5_000_000);
		for (let i = 0; i < 1000; i++) {
			await store.put(
				`/r${i}`,
				{ kind: 'redirect', status: 301, location: '/x', created: 0 },
				{ ttl: 60 }
			);
		}
		expect(await store.size!()).toBe(1000);
	});
});
