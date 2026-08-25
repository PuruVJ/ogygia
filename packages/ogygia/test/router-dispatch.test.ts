import { describe, it, expect } from 'vitest';
import { routes } from '../src/router/router.js';

const req = (path: string, init?: RequestInit) => new Request('http://x' + path, init);

describe('router dispatch — endpoints & params', () => {
	const app = routes((r) =>
		r.routes({
			'/': (r) => r.GET((c) => c.json({ home: true })),
			'/docs/[slug]': (r) => r.GET((c) => c.json({ slug: c.params.slug })),
			'/api/[id]': (r) => r.GET((c) => c.json({ read: c.params.id })).PUT((c) => c.json({ put: c.params.id })),
			'/files/[...path]': (r) => r.GET((c) => c.json({ path: c.params.path }))
		})
	);

	it('routes GET endpoints with typed params', async () => {
		expect(await (await app.fetch(req('/')))!.json()).toEqual({ home: true });
		expect(await (await app.fetch(req('/docs/intro')))!.json()).toEqual({ slug: 'intro' });
		expect(await (await app.fetch(req('/files/a/b')))!.json()).toEqual({ path: 'a/b' });
	});

	it('falls through (null) on no match when unbased', async () => {
		expect(await app.fetch(req('/nope'))).toBeNull();
	});

	it('dispatches verbs and 405s the rest with allow', async () => {
		expect(await (await app.fetch(req('/api/7')))!.json()).toEqual({ read: '7' });
		expect(await (await app.fetch(req('/api/7', { method: 'PUT' })))!.json()).toEqual({ put: '7' });
		const bad = await app.fetch(req('/api/7', { method: 'DELETE' }));
		expect(bad!.status).toBe(405);
		expect(bad!.headers.get('allow')).toBe('GET, PUT');
	});

	it('answers OPTIONS from the known method set', async () => {
		const o = await app.fetch(req('/api/7', { method: 'OPTIONS' }));
		expect(o!.status).toBe(204);
		expect(o!.headers.get('allow')).toBe('GET, PUT');
	});
});

describe('router — data cascade (Kit parent())', () => {
	const app = routes((r) =>
		r.load(() => ({ a: 1 })).routes({
			'/x': (r) =>
				r.load(() => ({ b: 2 })).routes({
					'/y': (r) => r.GET((c) => c.json(c.data))
				}),
			'/flat': (r) => r.GET((c) => c.json(c.data))
		})
	);

	it('merges every ancestor load, top-down, into c.data', async () => {
		expect(await (await app.fetch(req('/x/y')))!.json()).toEqual({ a: 1, b: 2 });
		expect(await (await app.fetch(req('/flat')))!.json()).toEqual({ a: 1 });
	});

	it('a load returning a Response short-circuits (redirect/error)', async () => {
		const guarded = routes((r) =>
			r.load((c) => c.redirect('/login')).routes({
				'/secret': (r) => r.GET((c) => c.json({ never: true }))
			})
		);
		const res = await guarded.fetch(req('/secret'));
		expect(res!.status).toBe(303);
		expect(res!.headers.get('location')).toBe('/login');
	});
});

describe('router — base + miss + slash', () => {
	const app = routes(
		(r) =>
			r.routes({
				'/': (r) => r.GET((c) => c.json({ ok: 1 })),
				'/x': (r) => r.GET((c) => c.json({ x: 1 }))
			}),
		{ base: '/__p', slash: 'never' }
	);

	it('strips base and owns its subtree (404 on miss, not fall-through)', async () => {
		expect(await (await app.fetch(req('/__p')))!.json()).toEqual({ ok: 1 });
		expect(await (await app.fetch(req('/__p/x')))!.json()).toEqual({ x: 1 });
		expect((await app.fetch(req('/__p/nope')))!.status).toBe(404);
		expect(await app.fetch(req('/elsewhere'))).toBeNull(); // outside base → not ours
	});

	it('canonicalizes a trailing slash (308)', async () => {
		const r = await app.fetch(req('/__p/x/'));
		expect(r!.status).toBe(308);
		expect(r!.headers.get('location')).toBe('/__p/x');
	});
});

describe('router — endpoint returns', () => {
	const app = routes((r) =>
		r.routes({
			'/plain': (r) => r.GET(() => ({ plain: true })), // bare object → JSON
			'/empty': (r) => r.GET(() => null), // null → 204
			'/resp': (r) => r.GET((c) => c.text('hi'))
		})
	);
	it('turns a bare object into JSON', async () => {
		const r = await app.fetch(req('/plain'));
		expect(r!.headers.get('content-type')).toContain('application/json');
		expect(await r!.json()).toEqual({ plain: true });
	});
	it('turns null into 204', async () => {
		expect((await app.fetch(req('/empty')))!.status).toBe(204);
	});
	it('passes a Response through', async () => {
		expect(await (await app.fetch(req('/resp')))!.text()).toBe('hi');
	});
});
