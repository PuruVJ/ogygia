/**
 * SizedLru (server/sized-lru.ts) — the byte-bounded LRU behind the region render cache and the
 * freeze memory store: bytes first, entries second, per-entry expiry, LRU touch on read, and the
 * two stores' behaviour on top of it (a multi-MB entry can never blow the budget).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SizedLru } from '../src/server/sized-lru.js';
import {
	render_cache_clear,
	render_cache_get,
	render_cache_set,
	render_cache_stats
} from '../src/server/render-cache.js';
import { memory_store } from '../src/freeze/memory-store.js';

describe('SizedLru', () => {
	it('bounds bytes: the least recently used entries evict until the new one fits', () => {
		const lru = new SizedLru<string>(100, 100);
		lru.set('a', 'A', 40, 1e9);
		lru.set('b', 'B', 40, 1e9);
		expect(lru.bytes).toBe(80);
		lru.set('c', 'C', 40, 1e9); // 120 > 100 → 'a' goes
		expect(lru.get('a', 0)).toBeNull();
		expect(lru.get('b', 0)).toBe('B');
		expect(lru.bytes).toBe(80);
		expect(lru.size).toBe(2);
	});

	it('a read is an LRU touch: the touched entry survives, the untouched one evicts', () => {
		const lru = new SizedLru<string>(100, 100);
		lru.set('a', 'A', 40, 1e9);
		lru.set('b', 'B', 40, 1e9);
		lru.get('a', 0);
		lru.set('c', 'C', 40, 1e9);
		expect(lru.get('b', 0)).toBeNull();
		expect(lru.get('a', 0)).toBe('A');
	});

	it('bounds entries too, and an entry larger than the whole budget is refused', () => {
		const lru = new SizedLru<string>(1000, 2);
		lru.set('a', 'A', 1, 1e9);
		lru.set('b', 'B', 1, 1e9);
		lru.set('c', 'C', 1, 1e9);
		expect(lru.size).toBe(2);
		expect(lru.has('a')).toBe(false);
		lru.set('huge', 'H', 5000, 1e9);
		expect(lru.has('huge')).toBe(false);
		expect(lru.bytes).toBe(2);
	});

	it('expiry: a read past `expires` misses and frees the bytes; sweep drops every expired entry', () => {
		const lru = new SizedLru<string>(1000, 10);
		lru.set('a', 'A', 10, 100);
		lru.set('b', 'B', 10, 200);
		expect(lru.get('a', 150)).toBeNull();
		expect(lru.bytes).toBe(10);
		lru.sweep(250);
		expect(lru.size).toBe(0);
		expect(lru.bytes).toBe(0);
	});

	it('overwriting a key replaces its bytes, never double-counts', () => {
		const lru = new SizedLru<string>(1000, 10);
		lru.set('a', 'A', 10, 1e9);
		lru.set('a', 'AA', 30, 1e9);
		expect(lru.bytes).toBe(30);
		expect(lru.size).toBe(1);
		lru.clear();
		expect(lru.bytes).toBe(0);
	});
});

describe('render cache is byte-bounded', () => {
	beforeEach(() => render_cache_clear());

	it('holds many small renders, but 2 MB renders evict each other long before 500 entries', () => {
		const big = 'x'.repeat(2_000_000);
		for (let i = 0; i < 40; i++) render_cache_set('big' + i, big, 60, 0);
		const { entries, bytes } = render_cache_stats();
		expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(entries).toBeLessThan(40);
		expect(entries).toBeGreaterThan(20);
		expect(render_cache_get('big39', 1)).toBe(big); // the newest survive
		expect(render_cache_get('big0', 1)).toBeNull(); // the oldest went
	});
});

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
			await store.put(`/r${i}`, { kind: 'redirect', status: 301, location: '/x', created: 0 }, { ttl: 60 });
		}
		expect(await store.size!()).toBe(1000);
	});
});
