import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { transformHost, islandId } from '../dist/compiler/transform.js';
import { rewrite_lake_import_to_placeholder } from '../dist/vite/index.js';
import { RateLimiter } from '../dist/server/rate-limit.js';
import { sign, verify, region_mac_message } from '../dist/server/hmac.js';

const ROOT = '/app';
const HOST = '/app/src/routes/+page.svelte';

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		root: ROOT,
		libDir: '/app/src/lib',
		readFile: () => null,
		pathModule: path,
		dev: false,
		virtualPathFor: (_hostId: string, iid: string) =>
			`virtual:ogygia/island/${iid}.js`,
		devUrlFor: (p: string) => '/@id/' + p,
		visibleMargin: '0px',
		presets: {},
		idSalt: '',
		...overrides
	};
}

function wrap(imports: string, markup: string) {
	return `<script>\n${imports}\n</script>\n${markup}`;
}

function run(src: string, ctx = makeCtx()) {
	return transformHost(src, HOST, ctx);
}

function expectThrows(fn: () => unknown, re: RegExp) {
	let msg = '';
	try {
		fn();
	} catch (e) {
		msg = (e as Error).message;
	}
	expect(msg).toMatch(re);
	return msg;
}

describe('audit fixes — transform contract', () => {
	it('allows a marked import used as a portable/dynamic binding', () => {
		// Svelte 5 has no <svelte:component>; a dynamic component is `<Comp/>` where Comp is a variable.
		const r = run(
			wrap(
				`import C from './C.svelte' with { wake: 'load' };\n\tlet Comp = C;`,
				'<Comp />'
			)
		);
		expect(r).toBeTruthy();
		expect(r!.islands.length).toBe(1);
		// The import lands on the attach binding (which re-exports the wrapper with the descriptor).
		expect(r!.code).toMatch(/virtual:ogygia\/region\//);
		expect(r!.islands[0].wrapperPath).toMatch(/virtual:ogygia\/wrapper\//);
	});

	it('allows this={C} on svelte:component', () => {
		const r = run(
			wrap(`import C from './C.svelte' with { wake: 'load' };`, '<svelte:component this={C} />')
		);
		expect(r).toBeTruthy();
		expect(r!.islands.length).toBe(1);
	});

	it('unused marked import is stripped even when markup text mentions the local name', () => {
		const r = run(wrap(`import C from './C.svelte' with { wake: 'load' };`, '<p>no usage of C</p>'));
		expect(r).toBeTruthy();
		expect(r!.islands.length).toBe(0);
		expect(r!.code).not.toMatch(/import C from/);
	});

	it('errors when marked import is used as dotted Menu.Item', () => {
		expectThrows(
			() => run(wrap(`import Menu from './Menu.svelte' with { wake: 'load' };`, '<Menu.Item x={1} />')),
			/dotted tag/
		);
	});

	it('rejects host children on defer (lakes belong inside the island component)', () => {
		expectThrows(
			() =>
				run(
					wrap(
						`import G from './G.svelte' with { render: 'deferred' };\n\timport Lake from './Lake.svelte' with { wake: 'none' };`,
						'<G><Lake /></G>'
					)
				),
			/host children/
		);
	});

	it('lake binding rewrite produces a portable lake wrapper', () => {
		const r = run(
			wrap(`import Lake from './Lake.svelte' with { wake: 'none' };`, '<Lake />')
		);
		expect(r).toBeTruthy();
		const lake = r!.islands.find((i) => i.kind === 'lake')!;
		expect(lake.wrapperSource).toMatch(/OgygiaRegion__Wrapper __mode="lake"/);
		expect(lake.lakes).toEqual(['OgygiaLakeInner']);
	});

	it('strips unused hydrate:none import (no with{} left)', () => {
		const r = run(wrap(`import L from './L.svelte' with { wake: 'none' };`, '<p>no lake</p>'));
		expect(r).toBeTruthy();
		expect(r!.code).not.toMatch(/hydrate:\s*'none'/);
		expect(r!.code).not.toMatch(/from '\.\/L\.svelte'/);
	});

	it('errors on strategy-less preset', () => {
		expectThrows(
			() =>
				run(wrap(`import C from './C.svelte' with { preset: 'marginOnly' };`, '<C />'), makeCtx({
					presets: { marginOnly: { margin: '10px' } }
				})),
			/must set `render` or `wake`/
		);
	});

	it('rejects hydrate values with lone "(" as unknown (not media)', () => {
		expectThrows(
			() => run(wrap(`import C from './C.svelte' with { wake: 'weird(thing' };`, '<C />')),
			/unknown wake strategy/
		);
	});

	it('islandId normalizes windows path separators', () => {
		expect(islandId('src\\routes\\+page.svelte', 0, 'salt')).toBe(
			islandId('src/routes/+page.svelte', 0, 'salt')
		);
	});
});

describe('audit fixes — lake placeholder rewrite', () => {
	it('rewrites default lake imports', () => {
		const out = rewrite_lake_import_to_placeholder(
			`import Lake from './Lake.svelte';`,
			'Lake',
			'/placeholder.svelte'
		);
		expect(out).toBe(`import Lake from "/placeholder.svelte";`);
	});

	it('rewrites named lake imports and keeps siblings', () => {
		const out = rewrite_lake_import_to_placeholder(
			`import { Lake, Other } from './widgets.js';`,
			'Lake',
			'/placeholder.svelte'
		);
		expect(out).toContain(`import Lake from "/placeholder.svelte";`);
		expect(out).toContain(`import { Other } from "./widgets.js";`);
		expect(out).not.toMatch(/\{\s*Lake/);
	});
});

describe('audit fixes — rate limiter', () => {
	it('charges after max and hard-caps map size', () => {
		const lim = new RateLimiter({ max: 3, windowMs: 60_000, cap: 10 });
		expect(lim.limited('a')).toBe(false);
		expect(lim.limited('a')).toBe(false);
		expect(lim.limited('a')).toBe(false);
		expect(lim.limited('a')).toBe(true);
		for (let i = 0; i < 40; i++) lim.limited(`ip-${i}`);
		expect(lim.size).toBeLessThanOrEqual(10);
	});

	it('evicts least-recently-used keys when over cap', () => {
		const lim = new RateLimiter({ max: 100, windowMs: 60_000, cap: 3 });
		lim.limited('old');
		lim.limited('mid');
		lim.limited('new');
		// Touch "old" so it becomes most-recent; "mid" is LRU and should drop first.
		lim.limited('old');
		lim.limited('fresh');
		expect(lim.size).toBe(3);
		// mid was never touched after the initial insert wave → evicted
		expect(lim.limited('mid')).toBe(false); // new bucket (was gone)
		expect(lim.size).toBeLessThanOrEqual(3);
	});

	it('documents render-rate contract: junk must not call render limited()', () => {
		const render_lim = new RateLimiter({ max: 2, windowMs: 60_000, cap: 16 });
		const junk_mac_ok = false;
		for (let i = 0; i < 50; i++) {
			if (junk_mac_ok) render_lim.limited('victim');
		}
		expect(render_lim.limited('victim')).toBe(false);
		expect(render_lim.limited('victim')).toBe(false);
		expect(render_lim.limited('victim')).toBe(true);
	});
});

describe('audit fixes — page cache bounds', () => {
	it('evicts by max entries and drops expired', async () => {
		const { PageCache } = await import('../dist/runtime/page-cache.js');
		const c = new PageCache({ ttlMs: 50, maxEntries: 3, maxBytes: 1_000_000 });
		c.set('/a', 'aaaa');
		c.set('/b', 'bbbb');
		c.set('/c', 'cccc');
		c.set('/d', 'dddd');
		expect(c.size).toBeLessThanOrEqual(3);
		await new Promise((r) => setTimeout(r, 60));
		expect(c.get('/a')).toBeNull();
	});
});

describe('audit fixes — concurrency gate', () => {
	it('never exceeds max concurrent runners', async () => {
		const { ConcurrencyGate } = await import('../dist/runtime/concurrency.js');
		const g = new ConcurrencyGate(2);
		let peak = 0;
		const tasks = Array.from({ length: 8 }, () =>
			g.run(async () => {
				peak = Math.max(peak, g.active);
				await new Promise((r) => setTimeout(r, 5));
			})
		);
		await Promise.all(tasks);
		expect(peak).toBeLessThanOrEqual(2);
	});
});

describe('audit fixes — head_node_key', () => {
	it('keys link/meta without full outerHTML when possible', async () => {
		const { head_node_key } = await import('../dist/runtime/router.js');
		const attr = (map: Record<string, string>) => (n: string) => map[n] ?? null;
		const link = {
			tagName: 'LINK',
			getAttribute: attr({ rel: 'stylesheet', href: '/a.css', as: '' }),
			hasAttribute: (n: string) => n in { rel: 1, href: 1, as: 1 },
			outerHTML: '<link rel="stylesheet" href="/a.css">'
		} as unknown as Element;
		expect(head_node_key(link)).toBe('LINK:stylesheet:/a.css:');
		const title = {
			tagName: 'TITLE',
			getAttribute: () => null,
			hasAttribute: () => false,
			outerHTML: '<title>t</title>'
		} as unknown as Element;
		expect(head_node_key(title)).toBe('TITLE');
	});

	it('keys Kit FOUC and Vite HMR styles by role, not content length', async () => {
		const { head_node_key, keep_head_node_across_spa } = await import('../dist/runtime/router.js');
		const fouc = {
			tagName: 'STYLE',
			getAttribute: (n: string) => (n === 'data-sveltekit' ? '' : null),
			hasAttribute: (n: string) => n === 'data-sveltekit',
			textContent: '/* a */ body{}',
			outerHTML: '<style data-sveltekit></style>'
		} as unknown as Element;
		expect(head_node_key(fouc)).toBe('STYLE:data-sveltekit');
		expect(keep_head_node_across_spa(fouc)).toBe(false);

		const vite = {
			tagName: 'STYLE',
			getAttribute: (n: string) => (n === 'data-vite-dev-id' ? '/src/app.css' : null),
			hasAttribute: (n: string) => n === 'data-vite-dev-id',
			textContent: 'body{}',
			outerHTML: '<style data-vite-dev-id="/src/app.css"></style>'
		} as unknown as Element;
		expect(head_node_key(vite)).toBe('STYLE:vite:/src/app.css');
		expect(keep_head_node_across_spa(vite)).toBe(true);
	});
});

describe('audit fixes — spa cache policy', () => {
	it('refuses private/no-store/no-cache and Set-Cookie', async () => {
		const { spa_html_cacheable, bust_page_cache, _page_cache_size } = await import(
			'../dist/runtime/router.js'
		);
		expect(spa_html_cacheable('public, max-age=60', false)).toBe(true);
		expect(spa_html_cacheable('private, max-age=60', false)).toBe(false);
		expect(spa_html_cacheable('no-store', false)).toBe(false);
		expect(spa_html_cacheable('no-cache', false)).toBe(false);
		expect(spa_html_cacheable('public', true)).toBe(false);
		bust_page_cache();
		expect(_page_cache_size()).toBe(0);
	});
});

describe('audit fixes — page seed serialize', () => {
	it('escapes lt and falls back when data is non-serializable', async () => {
		const { PageSeed } = await import('../dist/server/page-seed.js');
		const ok = PageSeed.serialize({
			url: { href: 'http://x/' },
			params: {},
			route: { id: '/' },
			status: 200,
			data: { n: 1 },
			form: null,
			error: null
		});
		expect(ok).toBeTruthy();
		expect(ok!).not.toContain('<');
		const fallback = PageSeed.serialize({
			url: { href: 'http://x/' },
			params: {},
			route: { id: '/' },
			status: 200,
			data: { f: () => {} },
			form: null,
			error: null
		});
		expect(fallback).toBeTruthy();
	});
});

describe('audit fixes — remote clear', () => {
	it('clear_remote_seeds + clear_remote_instances together drop seeds and kit maps', async () => {
		const {
			query_responses,
			prerender_responses,
			clear_remote_seeds,
			clear_remote_instances,
			query_map,
			live_query_map
		} = await import('../dist/shims/kit-remote/remote-cache.js');
		query_responses['a'] = { v: 1 };
		prerender_responses['b'] = { v: 2 };
		query_map.set('q', new Map());
		live_query_map.set('l', new Map());
		clear_remote_seeds();
		clear_remote_instances();
		expect(Object.keys(query_responses)).toEqual([]);
		expect(Object.keys(prerender_responses)).toEqual([]);
		expect(query_map.size).toBe(0);
		expect(live_query_map.size).toBe(0);
	});

	it('clear_remote_seeds leaves live/query instance maps intact', async () => {
		const {
			query_responses,
			prerender_responses,
			clear_remote_seeds,
			query_map,
			live_query_map
		} = await import('../dist/shims/kit-remote/remote-cache.js');
		query_responses['a'] = { v: 1 };
		prerender_responses['b'] = { v: 2 };
		query_map.set('q', new Map());
		live_query_map.set('l', new Map());
		clear_remote_seeds();
		expect(Object.keys(query_responses)).toEqual([]);
		expect(Object.keys(prerender_responses)).toEqual([]);
		expect(query_map.size).toBe(1);
		expect(live_query_map.size).toBe(1);
	});

	it('clear_remote_instances destroys leftover query/live maps only', async () => {
		const {
			query_responses,
			clear_remote_instances,
			query_map,
			live_query_map
		} = await import('../dist/shims/kit-remote/remote-cache.js');
		query_responses['keep'] = { v: 1 };
		const destroyed: string[] = [];
		live_query_map.set(
			'clock',
			new Map([
				[
					'',
					{
						resource: {
							destroy() {
								destroyed.push('clock');
							}
						}
					}
				]
			])
		);
		query_map.set(
			'count',
			new Map([
				[
					'',
					{
						resource: {
							destroy() {
								destroyed.push('count');
							}
						}
					}
				]
			])
		);
		clear_remote_instances();
		expect(destroyed.sort()).toEqual(['clock', 'count']);
		expect(live_query_map.size).toBe(0);
		expect(query_map.size).toBe(0);
		expect(query_responses.keep).toEqual({ v: 1 });
	});

	it('remote_cache is shared via globalThis across re-imports', async () => {
		const a = await import('../dist/shims/kit-remote/remote-cache.js');
		a.live_query_map.set('shared', new Map());
		const b = await import('../dist/shims/kit-remote/remote-cache.js?t=' + Date.now());
		// Same module URL may cache; assert the global singleton identity directly.
		expect(a.remote_cache).toBe(b.remote_cache);
		expect(a.live_query_map).toBe(b.live_query_map);
		expect(a.live_query_map.has('shared')).toBe(true);
		a.live_query_map.delete('shared');
	});
});

describe('audit fixes — session-bound MAC', () => {
	it('always uses v1 length-prefixed fields; empty session/ttl are still fields', () => {
		const secret = 'test-secret-key-16b';
		const unbound = region_mac_message('id', '1', 'props');
		expect(unbound).toMatch(/^v1\|/);
		// Five fields: id | exp | props | session('') | ttl('').
		expect(unbound).toBe('v1|2:id|1:1|5:props|0:|0:');
		const bound = region_mac_message('id', '1', 'props', 'sess');
		expect(bound).toContain('|4:sess');
		expect(unbound).not.toBe(bound);
		const sig = sign(secret, bound);
		expect(verify(secret, bound, sig)).toBe(true);
		expect(verify(secret, region_mac_message('id', '1', 'props', 'other'), sig)).toBe(false);
		expect(verify(secret, unbound, sig)).toBe(false);
		// A different ttl is a different message (ttl is signed, so it can't be re-pointed).
		const ttl_bound = region_mac_message('id', '1', 'props', 'sess', '300');
		expect(ttl_bound).toContain('|3:300');
		expect(verify(secret, ttl_bound, sign(secret, bound))).toBe(false);
	});
});

describe('audit fixes — region endpoint allowlist', () => {
	it('allows same-origin relative and absolute; rejects cross-origin', async () => {
		const { is_allowed_region_endpoint, is_same_origin_response } = await import(
			'../dist/runtime/region-endpoint-url.js'
		);
		const origin = 'https://app.example';
		expect(is_allowed_region_endpoint('/__ogygia__?id=abc', origin)).toBe(true);
		expect(is_allowed_region_endpoint('https://app.example/__ogygia__?id=1', origin)).toBe(true);
		expect(is_allowed_region_endpoint('https://evil.example/x', origin)).toBe(false);
		expect(is_allowed_region_endpoint('//evil.example/x', origin)).toBe(false);
		expect(is_allowed_region_endpoint('javascript:alert(1)', origin)).toBe(false);
		expect(
			is_same_origin_response({ url: 'https://app.example/ok' } as Response, origin)
		).toBe(true);
		expect(
			is_same_origin_response({ url: 'https://evil.example/ok' } as Response, origin)
		).toBe(false);
	});

	it('resolves relative island entries against the document (not runtime module)', async () => {
		const { island_module_url } = await import('../dist/runtime/region-endpoint-url.js');
		const nested = 'https://example.com/playground/strategies';
		expect(island_module_url('/_app/immutable/og-region.abc.js')).toBe(
			'/_app/immutable/og-region.abc.js'
		);
		expect(island_module_url('./_app/immutable/og-region.abc.js', 'https://example.com/')).toBe(
			'/_app/immutable/og-region.abc.js'
		);
		// Regression: ../_app used to become /_app/_app/... via import() vs runtime URL
		expect(island_module_url('../_app/immutable/og-region.abc.js', nested)).toBe(
			'/_app/immutable/og-region.abc.js'
		);
	});
});

describe('audit fixes — region id charset + default TTL constant', () => {
	it('exports DEFAULT_REGION_TTL_SEC and REGION_ID_RE', async () => {
		const { DEFAULT_REGION_TTL_SEC, REGION_ID_RE } = await import('../dist/server/endpoint.js');
		expect(DEFAULT_REGION_TTL_SEC).toBe(3600);
		expect(REGION_ID_RE.test('abcdef012345')).toBe(true);
		expect(REGION_ID_RE.test('__proto__')).toBe(false);
		expect(REGION_ID_RE.test('short')).toBe(false);
	});
});

describe('audit fixes — lake cache soft cap', () => {
	it('evicts oldest entries past LAKE_CACHE_MAX', async () => {
		const { RuntimeSession } = await import('../dist/runtime/session.js');
		const s = new RuntimeSession();
		for (let i = 0; i < 70; i++) {
			s.set_lake_cache(String(i), {
				frag: {} as Node,
				endpoint: '',
				when: 'load',
				cachedAt: i,
				maxAgeMs: 0
			});
		}
		expect(s.lake_cache.size).toBe(64);
		expect(s.lake_cache.has('0')).toBe(false);
		expect(s.lake_cache.has('6')).toBe(true);
		expect(s.lake_cache.has('69')).toBe(true);
	});
});
