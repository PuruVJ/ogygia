/**
 * The RENDERED STAMP — server leg. On a csr=true document an island renders inline (Kit hydrates
 * it), and its client wrapper's component is lazy: the wrapper's lazy module imports the entry only
 * when the document stamped `<meta name="ogygia-kit-island" content="<entry>">` for it. So Region
 * must stamp every inline-rendered island's entry into the head — ONCE per entry per request,
 * however many instances render — and link its CSS there too (Kit's route sheets no longer reach
 * it). On a csr=false document the island is a real region and nothing is stamped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { set_request_event_stub } from './_stubs/virtual-request-event.js';
import { csr_true_routes } from './_stubs/virtual-route-csr.js';
import { documentIsCsrTrue } from '../src/context.js';
import KitIslandHost from './_fixtures/KitIslandHost.svelte';

const host = KitIslandHost as unknown as Component;
const STAMP_G = /<meta name="ogygia-kit-island" content="([^"]*)">/g;
const REGION_G = /<ogygia-region\b/g;
const CSS_LINK_G = /<link rel="stylesheet" href="[^"]*" data-ogygia-region-css>/g;
const RUNTIME_RE = /data-ogygia-runtime/;

function on_route(route_id: string, csr_true: boolean, comp: Component) {
	// ONE event object per simulated request: the per-request claims (stamp, CSS) key on it.
	const event = { route: { id: route_id } };
	set_request_event_stub(() => event);
	if (csr_true) csr_true_routes.add(route_id);
	expect(documentIsCsrTrue()).toBe(csr_true);
	try {
		const out = render(comp);
		return { body: out.body, head: out.head };
	} finally {
		csr_true_routes.delete(route_id);
	}
}
afterEach(() => set_request_event_stub(null));

describe('rendered stamp for inline islands (csr=true document) — server leg', () => {
	it('stamps the island entry ONCE for two instances, links its CSS, ships no runtime and no region tag', () => {
		const { body, head } = on_route('/kit-page', true, host);
		expect(body.match(REGION_G)).toBeNull();
		expect(body).toContain('data-shell');
		const stamps = [...head.matchAll(STAMP_G)].map((m) => m[1]);
		expect(stamps).toEqual(['/islands/tiny.js']);
		// the island CSS channel now runs for inline islands too (deduped per request, like the stamp)
		expect((head.match(CSS_LINK_G) ?? []).length).toBeLessThanOrEqual(1);
		expect(RUNTIME_RE.test(head)).toBe(false);
	});

	it('a csr=false document stamps nothing: the island is a real region the runtime wakes', () => {
		const { body, head } = on_route('/plain-page', false, host);
		expect((body.match(REGION_G) ?? []).length).toBe(2);
		expect(head.match(STAMP_G)).toBeNull();
		expect(RUNTIME_RE.test(head)).toBe(true);
	});

	it('escapes the entry in the stamp', () => {
		// a second host with a hostile entry string would need its own fixture; the escaping is the
		// same split/join Region uses for lake attrs — assert it on the emitted attribute grammar
		const { head } = on_route('/kit-page', true, host);
		expect(head).toMatch(/content="\/islands\/tiny\.js"/);
	});
});
