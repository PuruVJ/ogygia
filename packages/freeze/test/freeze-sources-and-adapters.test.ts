// og.source() receipts, as freeze uses them: the reverse index (invalidate-by-fn → evictByTag →
// edge url purges), and the three BYO store/edge adapters added for it (upstash REST, cloudflare
// purge, cloudflare KV sentinel-key tag index). The macro + runtime themselves are core's
// (packages/core/test/source.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	__og_source,
	fingerprint_args,
	source_tag,
	set_source_recorder
} from '../../core/src/source.ts';
import { configure, reset_for_tests, freeze_put, freeze_get, invalidate } from '../src/registry.ts';
import { memory_store } from '../src/memory-store.ts';
import { upstash } from '../src/adapters/upstash.ts';
import { cloudflare } from '../src/adapters/cloudflare.ts';
import { cloudflareKv, type KvNamespaceLike } from '../src/adapters/cloudflare-kv.ts';
import type { FreezeEntry, EdgeAdapter } from '../src/types.ts';

const page_entry = (): FreezeEntry => ({
	kind: 'page',
	html: '<html>x</html>',
	headers: { 'content-type': 'text/html' },
	created: Date.now()
});

// ── the reverse index end to end (registry + memory store + edges) ─────────────────────────────

describe('invalidate(fn, args) — the reverse index', () => {
	beforeEach(() => reset_for_tests());
	afterEach(() => {
		reset_for_tests();
		set_source_recorder(null);
	});

	it('evicts exactly the consuming keys and purges them at every edge', async () => {
		const purged: string[] = [];
		const edge: EdgeAdapter = {
			name: 'e',
			headers: () => ({}),
			purgeUrl: async (url) => void purged.push(url),
			purgeWhere: async () => {}
		};
		configure({ store: memory_store(), edge: [edge] });
		const fn = __og_source('lib/cms.ts#read', (slug: string) => slug);
		const tag = source_tag('lib/cms.ts#read', fingerprint_args(['promo']));
		await freeze_put('/fr/fr/a', page_entry(), { ttl: 60, tags: [tag] });
		await freeze_put('/en/us/b', page_entry(), { ttl: 60, tags: [tag] });
		await freeze_put('/bystander', page_entry(), { ttl: 60 });

		await invalidate(fn, ['promo']);
		expect(await freeze_get('/fr/fr/a')).toBeNull();
		expect(await freeze_get('/en/us/b')).toBeNull();
		expect(await freeze_get('/bystander')).not.toBeNull();
		expect(purged.sort()).toEqual(['/en/us/b', '/fr/fr/a']);
	});

	it('throws the macro-law error on an unstamped function', async () => {
		await expect(invalidate((() => 0) as never, [])).rejects.toThrow(/not a declared source/);
	});
});

// ── the BYO adapters ───────────────────────────────────────────────────────────────────────────

describe('upstash store (REST command shapes)', () => {
	const calls: unknown[][] = [];
	beforeEach(() => {
		calls.length = 0;
		const results = new Map<string, string>();
		const ttls = new Map<string, number>();
		vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
			const parts = JSON.parse(String(init?.body)) as string[];
			calls.push(parts);
			let result: unknown = 'OK';
			if (parts[0] === 'GET') result = results.get(parts[1]) ?? null;
			if (parts[0] === 'SET') results.set(parts[1], parts[2]);
			if (parts[0] === 'SMEMBERS') result = ['/fr/fr/a'];
			if (parts[0] === 'SCAN') result = ['0', []];
			if (parts[0] === 'TTL') result = ttls.get(parts[1]) ?? -1;
			if (parts[0] === 'EXPIRE') ttls.set(parts[1], Number(parts[2]));
			return new Response(JSON.stringify({ result }), { status: 200 });
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('speaks the REST protocol: SET EX, SADD/EXPIRE tags, SMEMBERS+DEL on evictByTag', async () => {
		const store = upstash({ url: 'https://x.upstash.io', token: 't' });
		await store.put('/fr/fr/a', page_entry(), { ttl: 120, tags: ['s:x#f:1'] });
		expect(calls).toContainEqual(['SET', 'og:a:/fr/fr/a', expect.any(String), 'EX', '120']);
		expect(calls).toContainEqual(['SADD', 'og:t:s:x#f:1', '/fr/fr/a']);
		expect(calls).toContainEqual(['EXPIRE', 'og:t:s:x#f:1', '120']);
		const keys = await store.evictByTag!('s:x#f:1');
		expect(keys).toEqual(['/fr/fr/a']);
		expect(calls).toContainEqual(['DEL', 'og:a:/fr/fr/a']);
		expect((await store.get('/fr/fr/a'))?.kind).toBe('page');
	});

	it('only ever extends a tag set’s expiry', async () => {
		const store = upstash({ url: 'https://x.upstash.io', token: 't' });
		await store.put('/page', page_entry(), { ttl: 86_400, tags: ['t'] });
		calls.length = 0;
		await store.put('/short', page_entry(), { ttl: 600, tags: ['t'] });
		expect(calls).toContainEqual(['TTL', 'og:t:t']);
		expect(calls.some((c) => c[0] === 'EXPIRE')).toBe(false);
	});

	it('a root prefix scans every key', async () => {
		const store = upstash({ url: 'https://x.upstash.io', token: 't' });
		await store.evictWhere({ prefix: '/' });
		expect(calls).toContainEqual(['SCAN', '0', 'MATCH', 'og:a:/*', 'COUNT', '250']);
	});
});

describe('cloudflare edge adapter', () => {
	const captured: { url: string; init: RequestInit }[] = [];
	beforeEach(() => {
		captured.length = 0;
		vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
			captured.push({ url: String(url), init: init ?? {} });
			return new Response('{"success":true}', { status: 200 });
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('bearer-authed zone purge: files for urls, prefixes for subtrees; cache-tag stamping', async () => {
		const edge = cloudflare({
			zoneId: 'z1',
			apiToken: 'tok',
			site: 'https://www.example.com'
		});
		expect(edge.headers({ url: '/fr/fr/x', ttl: 60 })['cache-tag']).toBe(
			'p:/fr,p:/fr/fr,p:/fr/fr/x'
		);
		await edge.purgeUrl('/fr/fr/x');
		expect(captured[0].url).toContain('/client/v4/zones/z1/purge_cache');
		expect((captured[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
		expect(JSON.parse(String(captured[0].init.body))).toEqual({
			files: ['https://www.example.com/fr/fr/x']
		});
		await edge.purgeWhere({ prefix: '/fr/fr/' });
		expect(JSON.parse(String(captured[1].init.body))).toEqual({
			prefixes: ['www.example.com/fr/fr']
		});
	});
});

describe('cloudflare KV store', () => {
	function fake_kv(): KvNamespaceLike & { data: Map<string, string> } {
		const data = new Map<string, string>();
		return {
			data,
			async get(key) {
				return data.get(key) ?? null;
			},
			async put(key, value) {
				data.set(key, value);
			},
			async delete(key) {
				data.delete(key);
			},
			async list({ prefix }) {
				return {
					keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
					list_complete: true
				};
			}
		};
	}

	it('round-trips, prefix-evicts, and runs the sentinel-key tag index', async () => {
		const kv = fake_kv();
		const store = cloudflareKv(kv);
		await store.put('/fr/fr/a', page_entry(), { ttl: 60, tags: ['s:x#f:1'] });
		await store.put('/fr/fr/b', page_entry(), { ttl: 60 });
		await store.put('/fright', page_entry(), { ttl: 60 });
		expect((await store.get('/fr/fr/a'))?.kind).toBe('page');

		const keys = await store.evictByTag!('s:x#f:1');
		expect(keys).toEqual(['/fr/fr/a']);
		expect(await store.get('/fr/fr/a')).toBeNull();

		await store.evictWhere({ prefix: '/fr/fr' });
		expect(await store.get('/fr/fr/b')).toBeNull();
		expect(await store.get('/fright')).not.toBeNull();

		await store.evictWhere({ prefix: '/' });
		expect(await store.get('/fright')).toBeNull();
	});
});
