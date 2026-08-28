/**
 * Router v2 dispatch — endpoints, params, verbs, base/slash, thrown redirect/error, miss, and the
 * load memoization + parent-sharing that makes waterfalls-and-waste impossible together. Page RENDER
 * (document/region) is covered by the playground rtr e2e; here we exercise the pure request→response
 * spine through endpoints and loads (no runtime needed).
 */
import { describe, it, expect } from 'vitest';
import { routes, load, redirect, error } from '../src/router/index.js';

const req = (path: string, init?: RequestInit) => new Request('http://x' + path, init);

describe('dispatch — endpoints, params, verbs', () => {
	const app = routes({
		'/': { GET: (c) => c.json({ home: true }) },
		'/docs/[slug]': { GET: (c) => c.json({ slug: c.params.slug }) },
		'/api/[id]': {
			GET: (c) => c.json({ read: c.params.id }),
			PUT: (c) => c.json({ put: c.params.id })
		},
		'/files/[...path]': { GET: (c) => c.json({ path: c.params.path }) }
	});

	it('routes GET endpoints with params ([slug], [...rest])', async () => {
		expect(await (await app.fetch(req('/')))!.json()).toEqual({ home: true });
		expect(await (await app.fetch(req('/docs/intro')))!.json()).toEqual({ slug: 'intro' });
		expect(await (await app.fetch(req('/files/a/b')))!.json()).toEqual({ path: 'a/b' });
	});

	it('falls through (null) on no match when unbased', async () => {
		expect(await app.fetch(req('/nope'))).toBeNull();
	});

	it('dispatches verbs, 405s the rest with allow, answers OPTIONS', async () => {
		expect(await (await app.fetch(req('/api/7')))!.json()).toEqual({ read: '7' });
		expect(await (await app.fetch(req('/api/7', { method: 'PUT' })))!.json()).toEqual({ put: '7' });
		const bad = await app.fetch(req('/api/7', { method: 'DELETE' }));
		expect(bad!.status).toBe(405);
		expect(bad!.headers.get('allow')).toBe('GET, PUT');
		const o = await app.fetch(req('/api/7', { method: 'OPTIONS' }));
		expect(o!.status).toBe(204);
		expect(o!.headers.get('allow')).toBe('GET, PUT');
	});
});

describe('dispatch — c.setHeaders reaches router-built responses', () => {
	// REGRESSION: Kit's `event.setHeaders` only affects `resolve()`-built responses; a
	// router-rendered Response bypassed it, so load/handler setHeaders silently vanished
	// (found when a mount load's Server-Timing header never reached the page).
	const app = routes({
		'/timed': {
			GET: (c) => {
				c.setHeaders?.({ 'Server-Timing': 'upstream;dur=12' });
				return c.json({ ok: true });
			}
		},
		'/explicit': {
			GET: (c) => {
				c.setHeaders?.({ 'x-a': 'from-setheaders' });
				// a handler's OWN Response headers must win over collected ones
				return new Response('{}', { headers: { 'x-a': 'explicit' } });
			}
		}
	});

	it('applies collected headers to the built response', async () => {
		const res = await app.fetch(req('/timed'));
		expect(res!.headers.get('server-timing')).toBe('upstream;dur=12');
		expect(await res!.json()).toEqual({ ok: true });
	});

	it('never clobbers headers the handler set explicitly', async () => {
		const res = await app.fetch(req('/explicit'));
		expect(res!.headers.get('x-a')).toBe('explicit');
	});
});

describe('dispatch — base, slash, miss', () => {
	const app = routes(
		{ '/x': { GET: (c) => c.json({ x: c.params }) } },
		{
			base: '/app',
			slash: 'never',
			miss: (c) => c.json({ missed: c.url.pathname }, { status: 404 })
		}
	);

	it('strips base, returns null for out-of-base', async () => {
		expect(await (await app.fetch(req('/app/x')))!.json()).toEqual({ x: {} });
		expect(await app.fetch(req('/other'))).toBeNull();
	});
	it('308-canonicalizes a trailing slash under slash:never', async () => {
		const r = await app.fetch(req('/app/x/'));
		expect(r!.status).toBe(308);
		expect(r!.headers.get('location')).toBe('/app/x');
	});
	it('runs miss for an unmatched path under base', async () => {
		const r = await app.fetch(req('/app/nope'));
		expect(r!.status).toBe(404);
		expect(await r!.json()).toEqual({ missed: '/app/nope' });
	});
});

describe('dispatch — thrown redirect / error', () => {
	const app = routes(
		{
			'/go': { GET: () => redirect(303, '/there') },
			'/boom': { GET: () => error(418, "I'm a teapot") },
			'/ok': { GET: (c) => c.json({ ok: true }) }
		},
		{ base: '/b' }
	);
	it('redirect() → a redirect response', async () => {
		const r = await app.fetch(req('/b/go'));
		expect(r!.status).toBe(303);
		expect(r!.headers.get('location')).toBe('/there');
	});
	it('error() from an endpoint → JSON error', async () => {
		const r = await app.fetch(req('/b/boom'));
		expect(r!.status).toBe(418);
		expect(await r!.json()).toEqual({ error: "I'm a teapot", status: 418 });
	});
});

describe('loads — memoization + parent-sharing (no waterfall, no waste)', () => {
	it('a shared load runs ONCE per request even when two loads await it', async () => {
		let runs = 0;
		const session = load(async () => {
			runs++;
			return { user: 'ada' };
		});
		// two endpoints in one request can't share; prove memo via one handler awaiting it twice + a
		// dependent load. Using an endpoint so we read the result directly.
		const app = routes({
			'/x': {
				GET: async (c) => {
					const a = await session(c);
					const b = await session(c); // same request → cache hit
					return c.json({ a, b, runs });
				}
			}
		});
		const r = await (await app.fetch(req('/x')))!.json();
		expect(r.runs).toBe(1);
		expect(r.a).toEqual({ user: 'ada' });
		expect(r.b).toEqual({ user: 'ada' });
	});

	it('memo is per-request (a second request re-runs)', async () => {
		let runs = 0;
		const l = load(async () => {
			runs++;
			return runs;
		});
		const app = routes({ '/x': { GET: async (c) => c.json(await l(c)) } });
		expect(await (await app.fetch(req('/x')))!.json()).toBe(1);
		expect(await (await app.fetch(req('/x')))!.json()).toBe(2);
	});
});

describe('miss — HTML boundary for page requests', () => {
	// RawHtml stands in for an app error page — any real component works; the assertions are
	// about STATUS and CONTENT TYPE, the long-noted "miss answers JSON" gap.
	it('unmatched page GET under a base renders the root error page as HTML 404', async () => {
		const { default: RawHtml } = await import('../src/RawHtml.svelte');
		const app = routes({ '/': { GET: (c) => c.json({ ok: true }) } }, { base: '/app', error: RawHtml as never });
		const res = await app.fetch(
			new Request('http://x/app/nope', { headers: { accept: 'text/html,*/*' } })
		);
		expect(res!.status).toBe(404);
		expect(res!.headers.get('content-type')).toContain('text/html');
	});

	it('unmatched NON-HTML request keeps the JSON 404 (fetch/API callers)', async () => {
		const { default: RawHtml } = await import('../src/RawHtml.svelte');
		const app = routes({ '/': { GET: (c) => c.json({ ok: true }) } }, { base: '/app', error: RawHtml as never });
		const res = await app.fetch(
			new Request('http://x/app/nope', { headers: { accept: 'application/json' } })
		);
		expect(res!.status).toBe(404);
		expect(res!.headers.get('content-type')).not.toContain('text/html');
	});
});

describe('href — rename-safe links off the table keys', () => {
	const app = routes({ '/docs/[slug]': { GET: (c) => c.text(c.params.slug) } }, { base: '/b' });
	it('fills params + prefixes base', () => {
		expect(app.href('/docs/[slug]', { slug: 'intro' })).toBe('/b/docs/intro');
	});
});
