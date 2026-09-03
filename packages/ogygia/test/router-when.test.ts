// `when()` — flag-gated routes, and the flag-picked canary mount. The unification law: a gated
// route that is OFF does not exist (unmatched contract: 404 under an owned base, fall-through
// without), a boolean flag() slots straight in as the gate, and the same `pick` verb that chooses
// components and values chooses INFRASTRUCTURE (mount(v2.pick({ off, on }))).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routes, when, mount } from '../src/router/index.js';
import { make_peer } from '../src/federation/peer.js';
import { flag, decide } from '../src/flags.js';

beforeEach(() => decide({ overrides: () => true, source: undefined, exposure: undefined }));
afterEach(() => vi.unstubAllGlobals());

const doc_json = () => JSON.stringify({ status: 200, title: 't', css: [], body: 'B' });

describe('when() — a gated-off route does not exist', () => {
	it('endpoint: off → fall-through (null, no base); on via ?og-exp → served', async () => {
		const api = flag('when-api'); // kill switch, off
		const app = routes({
			'/api/x': when(api, { GET: (c) => c.json({ ok: 1 }) })
		});
		expect(await app.fetch(new Request('http://s/api/x'))).toBeNull(); // OFF = not ours
		const on = await app.fetch(new Request('http://s/api/x?og-exp=when-api:on'));
		expect(on!.status).toBe(200);
		expect(await on!.json()).toEqual({ ok: 1 });
	});

	it('page under an owned base: off → 404 without ever touching the page (no network)', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new Error('gated-off mount must never fetch');
		});
		const rollout = flag('when-cms'); // off
		const app = routes(
			{
				'/cms/[...rest]': when(
					rollout,
					mount(make_peer('cms', { origin: 'http://never.test' }, 'shell'))
				)
			},
			{ base: '/app' }
		);
		const res = await app.fetch(new Request('http://s/app/cms/hello'));
		expect(res!.status).toBe(404);
	});

	it('the gate is any (c) => boolean — a plain predicate works', async () => {
		const app = routes({
			'/maybe': when((c) => c.url.searchParams.has('yes'), { GET: (c) => c.json({ hi: true }) })
		});
		expect(await app.fetch(new Request('http://s/maybe'))).toBeNull();
		expect((await app.fetch(new Request('http://s/maybe?yes')))!.status).toBe(200);
	});

	it('the gate decision self-registers for federation carry (like any flag read)', async () => {
		const gate = flag('when-carried');
		const app = routes({
			'/g': when(gate, { GET: (c) => c.json({}) })
		});
		const req = new Request('http://s/g?og-exp=when-carried:on');
		await app.fetch(req);
		const { assigned_buckets } = await import('../src/flags.js');
		expect(assigned_buckets(req)).toEqual({ 'when-carried': 'on' });
	});
});

describe('mount(pick) — the flag-picked canary', () => {
	it('routes the hop through the picked client, stickily per visitor', async () => {
		const seen: string[] = [];
		vi.stubGlobal('fetch', async (u: URL | string) => {
			seen.push(String(u));
			return new Response(doc_json());
		});
		const v2 = flag('cms-v2-canary'); // off by default; forced per-request via ?og-exp
		const v1_peer = make_peer('cms', { origin: 'http://a.test' }, 'shell');
		const v2_peer = make_peer('cms', { origin: 'http://b.test' }, 'shell');
		const app = routes({
			'/cms/[...rest]': mount(v2.pick({ off: v1_peer, on: v2_peer }))
		});
		const on = await app.fetch(new Request('http://shell/cms/x?og-exp=cms-v2-canary:on'));
		expect(on!.status).toBe(200);
		expect(seen[0]).toContain('http://b.test');
		const off = await app.fetch(new Request('http://shell/cms/x'));
		expect(off!.status).toBe(200);
		expect(seen[1]).toContain('http://a.test');
	});

	it('a pick that yields a non-client throws loudly, naming the fix', async () => {
		const v2 = flag('cms-v2-bad');
		const app = routes({
			'/cms/[...rest]': mount(v2.pick({ off: 'not-a-client', on: 'nope' }))
		});
		// the throw happens inside the page load → the host's 500 pipeline (a rejection, not a
		// silently-wrong hop), with the fix in the message
		await expect(app.fetch(new Request('http://shell/cms/x'))).rejects.toThrow(/must yield a peer/);
	});
});
