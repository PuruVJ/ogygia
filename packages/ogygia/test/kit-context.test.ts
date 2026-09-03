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
	empty_kit_page,
	KIT_REQUEST_CONTEXT,
	type KitPage
} from '../src/server/kit-context.js';
import PageProbe from './_fixtures/PageProbe.svelte';

const probe = PageProbe as unknown as Component;

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
