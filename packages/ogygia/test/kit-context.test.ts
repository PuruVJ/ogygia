/**
 * Kit's `__request__` context for ogygia's own server render roots (server/kit-context.ts).
 *
 * Kit's server `$app/state` reads `getContext('__request__').page.*`; every `svelte/server`
 * `render()` ogygia starts (document root, inline island, deferred endpoint, snippet body) is a
 * fresh root that must carry the same key — or `page.data` during SSR crashes with "reading 'page'
 * of undefined" (the bug this pins: found on a router-served MFE page).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import {
	kit_render_context,
	set_kit_page_reader,
	set_kit_event_reader,
	empty_kit_page,
	KIT_REQUEST_CONTEXT,
	KIT_STORES_CONTEXT,
	type KitPage
} from '../src/server/kit-context.js';
import PageProbe from './_fixtures/PageProbe.svelte';
import EventProbe from './_fixtures/EventProbe.svelte';
import KitPagePass from './_fixtures/KitPagePass.svelte';

const probe = PageProbe as unknown as Component;
const event_probe = EventProbe as unknown as Component;

const page_of = (over: Partial<KitPage>): KitPage => ({ ...empty_kit_page(), ...over });

afterEach(() => set_kit_page_reader(null));

describe('kit_render_context', () => {
	it('carries Kit’s key, and an explicit page wins over the reader', () => {
		set_kit_page_reader(() => page_of({ status: 500 }));
		const ctx = kit_render_context(page_of({ status: 201 }));
		expect((ctx.get(KIT_REQUEST_CONTEXT) as { page: KitPage }).page.status).toBe(201);
	});

	it('falls back to the request reader (hooks.ts installs it), then to an empty page', () => {
		expect((kit_render_context().get(KIT_REQUEST_CONTEXT) as { page: KitPage }).page).toEqual(
			empty_kit_page()
		);
		set_kit_page_reader(() => page_of({ data: { site: 'ACME' } }));
		expect((kit_render_context().get(KIT_REQUEST_CONTEXT) as { page: KitPage }).page.data).toEqual({
			site: 'ACME'
		});
	});

	it('a fresh svelte/server root sees the page the way Kit’s $app/state reads it', () => {
		const page = page_of({
			status: 200,
			url: new URL('http://localhost/cms/'),
			route: { id: '/cms' },
			data: { site: 'ACME CMS' }
		});
		const out = render(probe, { props: {}, context: kit_render_context(page) });
		expect(out.body).toContain('200|/cms/|/cms|{"site":"ACME CMS"}');
	});

	it('without the context the same root has nothing — the crash this seam prevents', () => {
		const out = render(probe, { props: {} });
		expect(out.body).toContain('NO CONTEXT');
	});

	it('the empty page never throws on any getter Kit’s $app/state exposes', () => {
		const out = render(probe, { props: {}, context: kit_render_context() });
		expect(out.body).toContain('200|-|-|{}');
	});
});

describe('kit_render_context — Kit’s `__svelte__` stores context ($app/stores)', () => {
	// The deprecated-but-everywhere `$page` store: Kit's server `$app/stores` destructures
	// `getContext('__svelte__')` into `{ page, navigating, updated }`. Found on a real header whose
	// every component reads `$page`: inside a server island it died with "Region render failed".
	it('carries page/navigating/updated stores that answer synchronously', () => {
		const page = page_of({ status: 404, data: { site: 'ACME' } });
		const stores = kit_render_context(page).get(KIT_STORES_CONTEXT) as {
			page: { subscribe(fn: (v: KitPage) => void): () => void };
			navigating: { subscribe(fn: (v: unknown) => void): () => void };
			updated: { subscribe(fn: (v: boolean) => void): () => void; check(): Promise<boolean> };
		};
		let seen: KitPage | undefined;
		const unsub = stores.page.subscribe((v) => (seen = v));
		expect(seen?.status).toBe(404);
		expect(seen?.data).toEqual({ site: 'ACME' });
		expect(typeof unsub).toBe('function');
		let nav: unknown = 'unset';
		stores.navigating.subscribe((v) => (nav = v));
		expect(nav).toBeNull();
		let up: boolean | undefined;
		stores.updated.subscribe((v) => (up = v));
		expect(up).toBe(false);
		return expect(stores.updated.check()).resolves.toBe(false);
	});

	it('the same page object feeds both contexts', () => {
		const page = page_of({ url: new URL('http://localhost/x/') });
		const ctx = kit_render_context(page);
		const via_state = (ctx.get(KIT_REQUEST_CONTEXT) as { page: KitPage }).page;
		let via_store: KitPage | undefined;
		(
			ctx.get(KIT_STORES_CONTEXT) as { page: { subscribe(fn: (v: KitPage) => void): void } }
		).page.subscribe((v) => (via_store = v));
		expect(via_store).toBe(via_state);
	});
});

describe('requestEvent() — the live RequestEvent for a server island (no $app/server import)', () => {
	// A `render: 'deferred'` component renders under the app's hooks, in the request that fetches
	// it. Kit's `getRequestEvent()` needs `$app/server`, which the client guard rejects the moment
	// a csr=true page shares the layout; remote functions are the other channel. This is the third:
	// the event rides the `__request__` context every ogygia render root already carries.
	it('reads the event the render context carries, and answers null without one', () => {
		const event = { locals: { user: 'ada' }, url: new URL('http://localhost/docs/') };
		const out = render(event_probe, { props: {}, context: kit_render_context(undefined, event) });
		expect(out.body).toContain('ada|/docs/');
		expect(render(event_probe, { props: {} }).body).toContain('NO EVENT');
	});

	// Kit's OWN page render sets `__request__` to `{ page }` only — no event. A layout, or anything a
	// page renders outside an island or hole, used to get `null` there (field: a per-request id counter
	// fell back to a process-wide one, SSR ids changed every request, a render cache never hit).
	it('under Kit’s own page render (context without an event), reads the installed reader', () => {
		const children = (renderer: unknown) => (event_probe as unknown as (r: unknown, p: unknown) => void)(renderer, {});
		const kit_pass = KitPagePass as unknown as Component<Record<string, unknown>>;
		expect(render(kit_pass, { props: { children } }).body).toContain('NO EVENT');
		set_kit_event_reader(() => ({ locals: { user: 'ada' }, url: new URL('http://localhost/home/') }));
		try {
			expect(render(kit_pass, { props: { children } }).body).toContain('ada|/home/');
		} finally {
			set_kit_event_reader(null);
		}
	});

	it('falls back to the installed event reader (hooks.ts) when no explicit event is passed', () => {
		set_kit_event_reader(() => ({ locals: { user: null }, url: new URL('http://localhost/x/') }));
		const out = render(event_probe, { props: {}, context: kit_render_context() });
		expect(out.body).toContain('guest|/x/');
		set_kit_event_reader(null);
		expect(render(event_probe, { props: {}, context: kit_render_context() }).body).toContain(
			'NO EVENT'
		);
	});
});
