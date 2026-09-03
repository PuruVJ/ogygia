// og.source() — the macro rewrite (strict position law), the runtime fingerprint, the reverse
// index (invalidate-by-fn → evictByTag → edge url purges), and the three BYO store/edge adapters
// added for it (upstash REST, cloudflare purge, cloudflare KV sentinel-key tag index).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rewrite_source } from '../src/compiler/macros/source.js';
import {
	__og_source,
	fingerprint_args,
	source_tag,
	SOURCE_ID
} from '../src/freeze/source-runtime.js';
import { set_source_recorder } from '../src/freeze/capture.js';
import {
	configure,
	reset_for_tests,
	freeze_put,
	freeze_get,
	invalidate
} from '../src/freeze/registry.js';
import { memory_store } from '../src/freeze/memory-store.js';
import { upstash } from '../src/freeze/adapters/upstash.js';
import { cloudflare } from '../src/freeze/adapters/cloudflare.js';
import { cloudflareKv, type KvNamespaceLike } from '../src/freeze/adapters/cloudflare-kv.js';
import type { FreezeEntry, EdgeAdapter } from '../src/freeze/types.js';

const MARKUP: readonly string[] = ['.svelte'];
const page_entry = (): FreezeEntry => ({
	kind: 'page',
	html: '<html>x</html>',
	headers: { 'content-type': 'text/html' },
	created: Date.now()
});

// ── the macro ──────────────────────────────────────────────────────────────────────────────────

describe('macros/source — strict position law', () => {
	it('rewrites the legal shape, stamping file#export and injecting the runtime import', () => {
		const src = `export const loadDoc = import.meta.og.source(async (slug) => slug);\n`;
		const out = rewrite_source(src, '/app/src/lib/server/cms.ts', 'src/lib/server/cms.ts', MARKUP);
		expect(out).toContain(`import { __og_source } from 'ogygia/freeze/source';`);
		expect(out).toContain(
			`export const loadDoc = __og_source("src/lib/server/cms.ts#loadDoc", async (slug) => slug)`
		);
	});

	it('keeps the optional { key } argument verbatim', () => {
		const src = `export const f = import.meta.og.source((a) => a, { key: (a) => String(a) });\n`;
		const out = rewrite_source(src, '/app/x.ts', 'x.ts', MARKUP);
		expect(out).toContain(`__og_source("x.ts#f", (a) => a, { key: (a) => String(a) })`);
	});

	it('is a no-op without the marker (same reference)', () => {
		const src = `export const f = () => 1;\n`;
		expect(rewrite_source(src, '/app/x.ts', 'x.ts', MARKUP)).toBe(src);
	});

	it('never rewrites the marker inside a string', () => {
		const src = `export const s = "export const f = import.meta.og.source(fn)";\n`;
		expect(rewrite_source(src, '/app/x.ts', 'x.ts', MARKUP)).toBe(src);
	});

	it('errors on a non-exported declaration', () => {
		const src = `const f = import.meta.og.source((a) => a);\n`;
		expect(() => rewrite_source(src, '/app/x.ts', 'x.ts', MARKUP)).toThrow(/export const/);
	});

	it('errors on bare access and on nested calls', () => {
		expect(() =>
			rewrite_source(`const x = [import.meta.og.source];\n`, '/app/x.ts', 'x.ts', MARKUP)
		).toThrow(/bare/);
		expect(() =>
			rewrite_source(
				`export const f = () => import.meta.og.source((a) => a);\n`,
				'/app/x.ts',
				'x.ts',
				MARKUP
			)
		).toThrow(/outside/);
	});

	it('errors on let / destructuring / wrong arity', () => {
		expect(() =>
			rewrite_source(
				`export let f = import.meta.og.source((a) => a);\n`,
				'/app/x.ts',
				'x.ts',
				MARKUP
			)
		).toThrow(/const/);
		expect(() =>
			rewrite_source(`export const f = import.meta.og.source();\n`, '/app/x.ts', 'x.ts', MARKUP)
		).toThrow(/args/);
	});
});

// ── the runtime ────────────────────────────────────────────────────────────────────────────────

describe('source-runtime', () => {
	afterEach(() => set_source_recorder(null));

	it('fingerprints are stable, order-insensitive on object keys, event-shape aware', () => {
		expect(fingerprint_args(['promo'])).toBe(fingerprint_args(['promo']));
		expect(fingerprint_args([{ a: 1, b: 2 }])).toBe(fingerprint_args([{ b: 2, a: 1 }]));
		expect(fingerprint_args(['promo'])).not.toBe(fingerprint_args(['other']));
		const event_ish = {
			url: new URL('http://x/fr/fr/home'),
			request: {} as never,
			route: { id: '/[lang]/[region]/home' }
		};
		// the same route+path fingerprints identically regardless of the rest of the event
		expect(fingerprint_args([event_ish])).toBe(
			fingerprint_args([{ ...event_ish, cookies: {} as never }])
		);
	});

	it('wraps: passes through, stamps the id, records the receipt tag', () => {
		const seen: string[] = [];
		set_source_recorder((tag) => seen.push(tag));
		const fn = __og_source('lib/cms.ts#read', (slug: string) => `doc:${slug}`);
		expect(fn('promo')).toBe('doc:promo');
		expect((fn as never as Record<symbol, string>)[SOURCE_ID]).toBe('lib/cms.ts#read');
		expect(seen).toEqual([source_tag('lib/cms.ts#read', fingerprint_args(['promo']))]);
	});

	it('honors the { key } canonicalizer', () => {
		const seen: string[] = [];
		set_source_recorder((tag) => seen.push(tag));
		const fn = __og_source('x#f', (a: { id: number }) => a.id, { key: (a) => String(a.id) });
		fn({ id: 7 });
		expect(seen).toEqual(['s:x#f:7']);
	});
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
		vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
			const parts = JSON.parse(String(init?.body)) as string[];
			calls.push(parts);
			let result: unknown = 'OK';
			if (parts[0] === 'GET') result = results.get(parts[1]) ?? null;
			if (parts[0] === 'SET') results.set(parts[1], parts[2]);
			if (parts[0] === 'SMEMBERS') result = ['/fr/fr/a'];
			if (parts[0] === 'SCAN') result = ['0', []];
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
	});
});
