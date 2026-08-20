/**
 * R6 server-side region render cache — TTL, LRU bound, per-session isolation, no-store default.
 * `now` is injected so TTL is deterministic (no wall-clock in tests).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	render_cache_key,
	render_cache_get,
	render_cache_set,
	render_cache_clear,
	cached_render
} from '../src/server/render-cache.js';

beforeEach(() => render_cache_clear());

describe('render_cache_key', () => {
	it('includes the session seal so users never cross; excludes exp/sig (not passed) and ttl', () => {
		const a = render_cache_key('id1', 'PROPS', 'sessionA');
		const b = render_cache_key('id1', 'PROPS', 'sessionB');
		expect(a).not.toBe(b); // different user → different key (no leak)
		expect(render_cache_key('id1', 'PROPS', '')).toBe(render_cache_key('id1', 'PROPS', '')); // stable
	});
});

describe('render_cache get/set', () => {
	it('stores and serves within the TTL window, misses after expiry', () => {
		const k = render_cache_key('id', 'p', '');
		render_cache_set(k, '<b>hi</b>', 10, 1000); // expires at 1000 + 10_000 = 11_000
		expect(render_cache_get(k, 5000)).toBe('<b>hi</b>'); // within window
		expect(render_cache_get(k, 11_000)).toBe(null); // at expiry → miss + evict
		expect(render_cache_get(k, 5000)).toBe(null); // evicted, gone
	});

	it('NEVER caches a dynamic (ttl <= 0) hole', () => {
		const k = render_cache_key('id', 'p', '');
		render_cache_set(k, 'x', 0, 1000);
		expect(render_cache_get(k, 1001)).toBe(null);
		render_cache_set(k, 'x', -5, 1000);
		expect(render_cache_get(k, 1001)).toBe(null);
	});

	it('two users with the same props get isolated entries (no cross-serve)', () => {
		const ka = render_cache_key('id', 'p', 'A');
		const kb = render_cache_key('id', 'p', 'B');
		render_cache_set(ka, 'A-html', 60, 0);
		expect(render_cache_get(kb, 1)).toBe(null); // user B never sees A's render
		render_cache_set(kb, 'B-html', 60, 0);
		expect(render_cache_get(ka, 1)).toBe('A-html');
		expect(render_cache_get(kb, 1)).toBe('B-html');
	});

	it('bounds memory — past 500 entries the oldest evict', () => {
		for (let i = 0; i < 600; i++) render_cache_set('k' + i, 'v' + i, 60, 0);
		expect(render_cache_get('k0', 1)).toBe(null); // oldest evicted
		expect(render_cache_get('k599', 1)).toBe('v599'); // newest kept
	});

	it('a read is an LRU touch — a recently-read entry survives eviction pressure', () => {
		render_cache_set('keep', 'v', 60, 0);
		for (let i = 0; i < 499; i++) render_cache_set('f' + i, 'x', 60, 0); // fill to 500
		render_cache_get('keep', 1); // touch → most-recent
		for (let i = 0; i < 100; i++) render_cache_set('g' + i, 'x', 60, 0); // pressure
		expect(render_cache_get('keep', 1)).toBe('v'); // survived because touched
	});
});

describe('cached_render — the shared seam (G2)', () => {
	it('renders once on cold, serves the memo on warm (within TTL)', async () => {
		let renders = 0;
		const body = () => {
			renders++;
			return '<p>' + renders + '</p>';
		};
		const cache = { key: render_cache_key('id', 'p', ''), ttl: 60 };
		const a = await cached_render(body, cache, 1000);
		const b = await cached_render(body, cache, 2000); // within TTL → memo, no re-render
		expect(a).toBe('<p>1</p>');
		expect(b).toBe('<p>1</p>');
		expect(renders).toBe(1); // rendered ONCE
	});

	it('re-renders after expiry, and NEVER caches a dynamic (no cache / ttl<=0) render', async () => {
		let renders = 0;
		const body = () => '<p>' + ++renders + '</p>';
		const cache = { key: render_cache_key('id2', 'p', ''), ttl: 10 };
		await cached_render(body, cache, 1000); // render 1, expires 11_000
		await cached_render(body, cache, 11_000); // expired → render 2
		expect(renders).toBe(2);
		// no cache object → always renders
		await cached_render(body, undefined, 1);
		await cached_render(body, undefined, 2);
		expect(renders).toBe(4);
	});

	it('a null render (failure) is never cached', async () => {
		let calls = 0;
		const body = () => {
			calls++;
			return null;
		};
		const cache = { key: render_cache_key('id3', 'p', ''), ttl: 60 };
		expect(await cached_render(body, cache, 1)).toBe(null);
		expect(await cached_render(body, cache, 2)).toBe(null);
		expect(calls).toBe(2); // both attempted — a failed render didn't poison the cache
	});
});
