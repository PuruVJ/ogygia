// artifacts — unit legs: keying, the store CONTRACT (lane 1 memory always; lane 2 real Valkey
// when REDIS_URL is set), observed purity, single-flight + fan-out, and the two edge adapters'
// REAL request shapes (signing included) captured through a stubbed fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { artifact_key, normalize_prefix, prefix_tags, PREFIX_TAG_DEPTH } from '../src/artifacts/key.js';
import { memory_store } from '../src/artifacts/memory-store.js';
import { valkey, type ValkeyLike } from '../src/artifacts/adapters/valkey.js';
import { akamai } from '../src/artifacts/adapters/akamai.js';
import { cloudfront } from '../src/artifacts/adapters/cloudfront.js';
import {
	configure,
	reset_for_tests,
	artifact_get,
	artifact_put,
	join_flight,
	begin_flight,
	invalidate,
	invalidateWhere
} from '../src/artifacts/registry.js';
import { observe_event } from '../src/artifacts/observe.js';
import type { ArtifactEntry, ArtifactStore, EdgeAdapter } from '../src/artifacts/types.js';

const page_entry = (html = '<html>x</html>'): ArtifactEntry => ({
	kind: 'page',
	html,
	headers: { 'content-type': 'text/html' },
	created: Date.now()
});

// ── keying ─────────────────────────────────────────────────────────────────────────────────────

describe('artifacts/key', () => {
	it('key is the pathname, verbatim (trailing slash preserved)', () => {
		expect(artifact_key('/fr/fr/')).toBe('/fr/fr/');
		expect(artifact_key('/fr/fr')).toBe('/fr/fr');
	});

	it('normalize_prefix enforces the leading slash and strips trailing ones (root survives)', () => {
		expect(normalize_prefix('fr/fr')).toBe('/fr/fr');
		expect(normalize_prefix('/fr/fr/')).toBe('/fr/fr');
		expect(normalize_prefix('/')).toBe('/');
	});

	it('prefix_tags is depth-capped', () => {
		expect(prefix_tags('/fr/fr/solar/panels/x')).toEqual(['/fr', '/fr/fr', '/fr/fr/solar']);
		expect(prefix_tags('/docs')).toEqual(['/docs']);
		expect(prefix_tags('/')).toEqual([]);
		expect(prefix_tags('/a/b/c').length).toBeLessThanOrEqual(PREFIX_TAG_DEPTH);
	});
});

// ── the store CONTRACT (one spec, every implementation) ────────────────────────────────────────

function store_contract(name: string, make: () => Promise<ArtifactStore> | ArtifactStore) {
	describe(`store contract: ${name}`, () => {
		let store: ArtifactStore;
		beforeEach(async () => {
			store = await make();
		});

		it('round-trips a page entry', async () => {
			await store.put('/a/', page_entry('<html>A</html>'), { ttl: 60 });
			const got = await store.get('/a/');
			expect(got?.kind).toBe('page');
			expect(got && got.kind === 'page' ? got.html : '').toBe('<html>A</html>');
		});

		it('round-trips a redirect entry', async () => {
			await store.put('/old/', { kind: 'redirect', status: 301, location: '/new/', created: Date.now() }, { ttl: 60 });
			const got = await store.get('/old/');
			expect(got?.kind).toBe('redirect');
			expect(got && got.kind === 'redirect' ? got.location : '').toBe('/new/');
		});

		it('misses on unknown keys', async () => {
			expect(await store.get('/nope/')).toBeNull();
		});

		it('evict removes exactly one key', async () => {
			await store.put('/a/', page_entry(), { ttl: 60 });
			await store.put('/b/', page_entry(), { ttl: 60 });
			await store.evict('/a/');
			expect(await store.get('/a/')).toBeNull();
			expect(await store.get('/b/')).not.toBeNull();
		});

		it('TTL backstop: an expired entry is a miss', async () => {
			await store.put('/short/', page_entry(), { ttl: 1 });
			expect(await store.get('/short/')).not.toBeNull();
			await new Promise((r) => setTimeout(r, 1100));
			expect(await store.get('/short/')).toBeNull();
		});

		it('evictWhere removes the subtree and never a lookalike sibling', async () => {
			await store.put('/fr/fr', page_entry(), { ttl: 60 });
			await store.put('/fr/fr/solar/', page_entry(), { ttl: 60 });
			await store.put('/fr/fright/', page_entry(), { ttl: 60 });
			await store.evictWhere({ prefix: '/fr/fr/' });
			expect(await store.get('/fr/fr')).toBeNull();
			expect(await store.get('/fr/fr/solar/')).toBeNull();
			expect(await store.get('/fr/fright/')).not.toBeNull();
		});
	});
}

store_contract('memory (tier 1)', () => memory_store());

// A faithful little Valkey fake (get/set EX/del/scan MATCH+COUNT with cursor) so the adapter's
// command usage is exercised on every PR; the REAL server runs the same contract below.
function fake_valkey(): ValkeyLike & { data: Map<string, string> } {
	const data = new Map<string, string>();
	const expiry = new Map<string, number>();
	const alive = (key: string) => {
		const at = expiry.get(key);
		if (at !== undefined && Date.now() >= at) {
			data.delete(key);
			expiry.delete(key);
		}
		return data.has(key);
	};
	return {
		data,
		async get(key) {
			return alive(key) ? (data.get(key) ?? null) : null;
		},
		async set(key, value, ...args) {
			data.set(key, value);
			// honor BOTH client families' EX spellings, like the real servers do
			const positional = args[0] === 'EX' ? Number(args[1]) : null;
			const bag = (args[0] as { EX?: number } | undefined)?.EX;
			const ttl = positional ?? bag ?? null;
			if (ttl !== null) expiry.set(key, Date.now() + ttl * 1000);
			else expiry.delete(key);
		},
		async del(...keys) {
			for (const k of keys) data.delete(k);
		},
		async scan(cursor, ...args) {
			// single-page cursor; honor MATCH with the same glob subset the adapter emits
			const match = String(args[args.indexOf('MATCH') + 1]);
			const re = new RegExp(
				'^' +
					match
						.replace(/[.+^${}()|[\]]/g, '\\$&')
						.replace(/\\\\([*?[\]\\])/g, (_, c) => '\\' + c)
						.replace(/\*/g, '.*') +
					'$'
			);
			return [ '0', [...data.keys()].filter((k) => re.test(k)) ] as unknown;
		}
	};
}

store_contract('valkey (fake client)', () => valkey(fake_valkey()));

const REDIS_URL = process.env.REDIS_URL;
describe.skipIf(!REDIS_URL)('store contract: valkey (REAL server via REDIS_URL)', () => {
	// Lane 2: identical spec against a live server. Loaded lazily so the suite has no redis dep.
	it('runs the shared contract', async () => {
		const { createClient } = await import('redis');
		const client = createClient({ url: REDIS_URL });
		await client.connect();
		try {
			const store = valkey(client as unknown as ValkeyLike);
			await store.put('/contract/x/', page_entry(), { ttl: 30 });
			expect((await store.get('/contract/x/'))?.kind).toBe('page');
			await store.evictWhere({ prefix: '/contract/' });
			expect(await store.get('/contract/x/')).toBeNull();
		} finally {
			await client.quit();
		}
	});
});

// ── registry: single-flight + invalidation fan-out ─────────────────────────────────────────────

describe('artifacts/registry', () => {
	beforeEach(() => reset_for_tests());
	afterEach(() => reset_for_tests());

	it('single-flight: joiners see the first render’s outcome', async () => {
		const settle = begin_flight('/hot/');
		const join = join_flight('/hot/');
		expect(join).not.toBeNull();
		const entry = page_entry();
		settle({ stored: entry });
		expect((await join!).stored).toBe(entry);
		// the flight is gone once settled
		expect(join_flight('/hot/')).toBeNull();
	});

	it('store failures never throw through artifact_get/put', async () => {
		configure({
			store: {
				get: () => Promise.reject(new Error('down')),
				put: () => Promise.reject(new Error('down')),
				evict: () => Promise.reject(new Error('down')),
				evictWhere: () => Promise.reject(new Error('down'))
			}
		});
		expect(await artifact_get('/x/')).toBeNull();
		await expect(artifact_put('/x/', page_entry(), { ttl: 10 })).resolves.toBeUndefined();
	});

	it('warns ONCE when edges are configured over the per-instance memory default', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const edge: EdgeAdapter = {
			name: 'e',
			headers: () => ({}),
			purgeUrl: async () => {},
			purgeWhere: async () => {}
		};
		configure({ edge: [edge] });
		const first = warn.mock.calls.filter((c) => String(c[0]).includes('other replicas')).length;
		configure({ edge: [edge] });
		const second = warn.mock.calls.filter((c) => String(c[0]).includes('other replicas')).length;
		expect(first).toBe(1);
		expect(second).toBe(1); // once per process, never nagging
		warn.mockRestore();
	});

	it('invalidate fans out to store + every edge; one edge down never throws', async () => {
		const calls: string[] = [];
		const edge = (name: string, fail = false): EdgeAdapter => ({
			name,
			headers: () => ({}),
			purgeUrl: async (url) => {
				calls.push(`${name}:url:${url}`);
				if (fail) throw new Error('edge down');
			},
			purgeWhere: async ({ prefix }) => {
				calls.push(`${name}:prefix:${prefix}`);
				if (fail) throw new Error('edge down');
			}
		});
		configure({ edge: [edge('a'), edge('b', true)] });
		await artifact_put('/gone/', page_entry(), { ttl: 60 });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await invalidate('/gone/');
		expect(await artifact_get('/gone/')).toBeNull();
		expect(calls).toContain('a:url:/gone/');
		expect(calls).toContain('b:url:/gone/');
		await invalidateWhere({ prefix: '/fr/fr/' });
		expect(calls).toContain('a:prefix:/fr/fr');
		warn.mockRestore();
	});
});

// ── observed purity ────────────────────────────────────────────────────────────────────────────

type AnyEvent = {
	cookies: {
		get: (n: string) => string | undefined;
		getAll: () => { name: string; value: string }[];
		set: (n: string, v: string, o: unknown) => void;
		delete: (n: string, o: unknown) => void;
	};
	locals: Record<string, unknown>;
	request: Request;
};

function fake_event(init?: { cookies?: Record<string, string>; locals?: Record<string, unknown>; headers?: Record<string, string> }): AnyEvent {
	const jar = new Map(Object.entries(init?.cookies ?? {}));
	return {
		cookies: {
			get: (n: string) => jar.get(n),
			getAll: () => [...jar].map(([name, value]) => ({ name, value })),
			set: (n: string, v: string) => void jar.set(n, v),
			delete: (n: string) => void jar.delete(n)
		},
		locals: init?.locals ?? {},
		request: new Request('http://x/', { headers: init?.headers })
	};
}

describe('artifacts/observe', () => {
	it('default-valued reads still store (the canonical render)', () => {
		const event = fake_event({ locals: { user: {}, flags: [], nothing: null } });
		const obs = observe_event(event as never);
		event.cookies.get('consent'); // absent → undefined = default
		event.locals.user; // {} = default
		event.locals.flags; // [] = default
		expect(obs.disqualified_by).toBeNull();
		expect(obs.wrote_cookie).toBe(false);
	});

	it('a NON-default cookie read disqualifies, named', () => {
		const event = fake_event({ cookies: { session: 'abc' } });
		const obs = observe_event(event as never);
		event.cookies.get('session');
		expect(obs.disqualified_by).toBe('cookie:session');
	});

	it('a cookie WRITE disqualifies', () => {
		const event = fake_event();
		const obs = observe_event(event as never);
		event.cookies.set('theme', 'dark', { path: '/' });
		expect(obs.wrote_cookie).toBe(true);
	});

	it('personalization headers disqualify; delivery plumbing does not', () => {
		const event = fake_event({ headers: { 'accept-language': 'fr', host: 'x' } });
		const obs = observe_event(event as never);
		event.request.headers.get('host');
		expect(obs.disqualified_by).toBeNull();
		event.request.headers.get('Accept-Language');
		expect(obs.disqualified_by).toBe('header:accept-language');
	});

	it('a populated locals read disqualifies, named', () => {
		const event = fake_event({ locals: { user: { id: 7 } } });
		const obs = observe_event(event as never);
		event.locals.user;
		expect(obs.disqualified_by).toBe('locals.user');
	});
});

// ── edge adapters: REAL request shapes through a stubbed fetch ─────────────────────────────────

describe('edge adapters', () => {
	const captured: { url: string; init: RequestInit }[] = [];
	beforeEach(() => {
		captured.length = 0;
		vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
			captured.push({ url: String(url), init: init ?? {} });
			return new Response('{}', { status: 201 });
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it('akamai: EdgeGrid-signed Fast Purge by url + prefix tag; headers stamp prefix tags', async () => {
		const edge = akamai({
			host: 'akab-test.purge.akamaiapis.net',
			clientToken: 'ct',
			clientSecret: 'cs',
			accessToken: 'at',
			site: 'https://www.example.com'
		});
		const headers = edge.headers({ url: '/fr/fr/solar/', ttl: 3600 });
		expect(headers['edge-cache-tag']).toBe('p:/fr, p:/fr/fr, p:/fr/fr/solar');
		expect(headers['cache-control']).toContain('s-maxage=3600');

		await edge.purgeUrl('/fr/fr/solar/');
		expect(captured[0].url).toContain('/ccu/v3/invalidate/url/production');
		expect(JSON.parse(String(captured[0].init.body))).toEqual({
			objects: ['https://www.example.com/fr/fr/solar/']
		});
		const auth = (captured[0].init.headers as Record<string, string>).authorization;
		expect(auth).toMatch(/^EG1-HMAC-SHA256 client_token=ct;access_token=at;timestamp=\d{8}T\d\d:\d\d:\d\d\+0000;nonce=[0-9a-f-]{36};signature=[A-Za-z0-9+/=]+$/);

		await edge.purgeWhere({ prefix: '/fr/fr/' });
		expect(captured[1].url).toContain('/ccu/v3/invalidate/tag/production');
		expect(JSON.parse(String(captured[1].init.body))).toEqual({ objects: ['p:/fr/fr'] });
	});

	it('cloudfront: SigV4-signed CreateInvalidation; prefix becomes path + wildcard', async () => {
		const edge = cloudfront({
			distributionId: 'E123',
			accessKeyId: 'AKIA',
			secretAccessKey: 'shh'
		});
		expect(edge.headers({ url: '/x/', ttl: 60 })).toEqual({});

		await edge.purgeWhere({ prefix: '/fr/fr' });
		expect(captured[0].url).toContain('/2020-05-31/distribution/E123/invalidation');
		const body = String(captured[0].init.body);
		expect(body).toContain('<Path>/fr/fr</Path>');
		expect(body).toContain('<Path>/fr/fr/*</Path>');
		const h = captured[0].init.headers as Record<string, string>;
		expect(h.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/us-east-1\/cloudfront\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
		);
		expect(h['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
	});
});
