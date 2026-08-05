import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { transformHost, islandId } from '../dist/vite/transform.js';
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
		virtualPathFor: (hostId: string, iid: string) =>
			path.join(path.dirname(hostId), '.ogygia', iid + '.svelte'),
		devUrlFor: (p: string) => '/' + path.relative(ROOT, p),
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
	it('errors when marked import is only used via svelte:component', () => {
		expectThrows(
			() =>
				run(
					wrap(
						`import C from './C.svelte' with { hydrate: 'load' };\n\tlet comp = C;`,
						'<svelte:component this={comp} />'
					)
				),
			/never used as a static component tag/
		);
	});

	it('errors when marked import is this={C} on svelte:component (no let alias)', () => {
		expectThrows(
			() =>
				run(
					wrap(`import C from './C.svelte' with { hydrate: 'load' };`, '<svelte:component this={C} />')
				),
			/never used as a static component tag/
		);
	});

	it('unused marked import is stripped even when markup text mentions the local name', () => {
		const r = run(wrap(`import C from './C.svelte' with { hydrate: 'load' };`, '<p>no usage of C</p>'));
		expect(r).toBeTruthy();
		expect(r!.islands.length).toBe(0);
		expect(r!.code).not.toMatch(/import C from/);
	});

	it('errors when marked import is used as dotted Menu.Item', () => {
		expectThrows(
			() => run(wrap(`import Menu from './Menu.svelte' with { hydrate: 'load' };`, '<Menu.Item x={1} />')),
			/never used as a static component tag/
		);
	});

	it('wraps lakes inside defer/server islands', () => {
		const r = run(
			wrap(
				`import G from './G.svelte' with { defer: 'load' };\n\timport Lake from './Lake.svelte' with { hydrate: 'none' };`,
				'<G><Lake /></G>'
			)
		);
		expect(r).toBeTruthy();
		expect(r!.islands.some((i) => i.server)).toBe(true);
		const virt = r!.islands.find((i) => i.source)!;
		expect(virt.lakes).toEqual(['Lake']);
		expect(virt.source).toMatch(/data-lake/);
		expect(virt.source).toMatch(/OgygiaLakeBoundary/);
	});

	it('strips unused hydrate:none import (no with{} left)', () => {
		const r = run(wrap(`import L from './L.svelte' with { hydrate: 'none' };`, '<p>no lake</p>'));
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
			/must set `hydrate` or `defer`/
		);
	});

	it('rejects hydrate values with lone "(" as unknown (not media)', () => {
		expectThrows(
			() => run(wrap(`import C from './C.svelte' with { hydrate: 'weird(thing' };`, '<C />')),
			/unknown hydrate strategy/
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
			outerHTML: '<link rel="stylesheet" href="/a.css">'
		} as unknown as Element;
		expect(head_node_key(link)).toBe('LINK:stylesheet:/a.css:');
		const title = {
			tagName: 'TITLE',
			getAttribute: () => null,
			outerHTML: '<title>t</title>'
		} as unknown as Element;
		expect(head_node_key(title)).toBe('TITLE');
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
	it('clear_remote_responses drops query + prerender maps and kit maps', async () => {
		const {
			query_responses,
			prerender_responses,
			clear_remote_responses,
			query_map,
			live_query_map
		} = await import('../dist/shims/kit-remote/remote-cache.js');
		query_responses['a'] = { v: 1 };
		prerender_responses['b'] = { v: 2 };
		query_map.set('q', new Map());
		live_query_map.set('l', new Map());
		clear_remote_responses();
		expect(Object.keys(query_responses)).toEqual([]);
		expect(Object.keys(prerender_responses)).toEqual([]);
		expect(query_map.size).toBe(0);
		expect(live_query_map.size).toBe(0);
	});
});

describe('audit fixes — session-bound MAC', () => {
	it('binds session when provided; empty session keeps 3-field form', () => {
		const secret = 's';
		const unbound = region_mac_message('id', '1', 'props');
		expect(unbound).toBe('id\0' + '1' + '\0props');
		const bound = region_mac_message('id', '1', 'props', 'sess');
		expect(bound).toBe('id\0' + '1' + '\0props\0sess');
		const sig = sign(secret, bound);
		expect(verify(secret, bound, sig)).toBe(true);
		expect(verify(secret, region_mac_message('id', '1', 'props', 'other'), sig)).toBe(false);
		expect(verify(secret, unbound, sig)).toBe(false);
	});
});
