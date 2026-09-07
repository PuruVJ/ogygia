/**
 * A LAKE (`wake: 'none'`) on a KIT-HYDRATED document (a csr=true page) — the server leg.
 *
 * Kit hydrates the whole document there, and the lake's component is a render-nothing placeholder
 * on the client, so the wrapper cannot render the lake as a normal template (Kit's hydration would
 * mismatch, discard the SSR DOM and re-render — the lake VANISHED; found on a site header). The
 * server must instead emit the lake as exactly ONE frozen `<ogygia-region wake="none">` element
 * that the client adopts verbatim (Region.svelte, lake branch), and everything authored INSIDE it
 * stays in ogygia's world: an island there emits its real region (not the csr=true inline form) and
 * the runtime script is claimed, because Kit never hydrates a lake's inside. The browser half
 * (adoption without mismatch, the island waking) is test/browser/lake-kit.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { set_request_event_stub } from './_stubs/virtual-request-event.js';
import { csr_true_routes } from './_stubs/virtual-route-csr.js';
import { documentIsCsrTrue } from '../src/context.js';
import LakeKitHost from './_fixtures/LakeKitHost.svelte';
import LakeKitInner from './_fixtures/LakeKitInner.svelte';

const host = LakeKitHost as unknown as Component;
const inner = LakeKitInner as unknown as Component;

const LAKE_OPEN_RE = /<ogygia-region entry="lake-1" wake="none" remount="cache">/;
// The lake element, then straight into the `{#if is_csr}` block's close marker: the render tag adds
// no anchor of its own, so the element is the whole branch — exactly the one node the client adopts.
const LAKE_RE =
	/<ogygia-region entry="lake-1" wake="none" remount="cache">([\s\S]*?)<\/ogygia-region><!--\]-->/;
const ISLAND_RE = /<ogygia-region entry="\/islands\/tiny\.js" wake="load"/;
const RUNTIME_RE = /data-ogygia-runtime/;
const REGION_G_RE = /<ogygia-region\b/g;

/** Render inside a request for `route_id` — csr=true when the id is in the build-time set.
 *  `render()`'s body/head are LAZY getters (the component runs on first read), so both are
 *  materialized here, while the simulated route is still in place. */
function on_route(route_id: string, csr_true: boolean, comp: Component) {
	set_request_event_stub(() => ({ route: { id: route_id } }));
	if (csr_true) csr_true_routes.add(route_id);
	expect(documentIsCsrTrue()).toBe(csr_true); // the simulated document reads as intended
	try {
		const out = render(comp);
		return { body: out.body, head: out.head };
	} finally {
		csr_true_routes.delete(route_id);
	}
}

afterEach(() => set_request_event_stub(null));

describe('lake under Kit hydration (csr=true document) — server leg', () => {
	it('emits the lake as ONE frozen region element with the lake HTML inside, nothing else in its branch', () => {
		const { body } = on_route('/kit', true, host);
		expect(body).toMatch(LAKE_OPEN_RE);
		const m = body.match(LAKE_RE);
		expect(m, body).not.toBeNull();
		expect(m![1]).toContain('<p data-inner="">frozen inside</p>');
		// exactly one lake element (one element to adopt), nothing of it leaks outside
		expect((body.match(/wake="none"/g) ?? []).length).toBe(1);
		expect(body).toContain('<div data-shell="">');
	});

	it('an island INSIDE the lake keeps its real region (no csr=true inline degradation) and claims the runtime', () => {
		const { body, head } = on_route('/kit', true, host);
		const lake = body.match(LAKE_RE)![1];
		expect(lake).toMatch(ISLAND_RE);
		expect(lake).toContain('<b data-tiny="">tiny</b>'); // SSR'd inside its region
		expect(lake).toContain('data-ogygia-props'); // with its props sidecar
		expect(head).toMatch(RUNTIME_RE); // the runtime wakes it — Kit never will
	});

	it('control: the same island OUTSIDE a lake degrades inline on the csr=true document', () => {
		const { body, head } = on_route('/kit', true, inner);
		expect(body).not.toMatch(REGION_G_RE);
		expect(body).toContain('<b data-tiny="">tiny</b>');
		expect(head).not.toMatch(RUNTIME_RE);
	});

	it('control: on a csr=false document a shell lake still renders bare (byte-identical to before)', () => {
		const { body } = on_route('/plain', false, host);
		expect(body).not.toContain('wake="none"');
		expect(body).toContain('<p data-inner="">frozen inside</p>');
		expect(body).toMatch(ISLAND_RE);
	});
});
