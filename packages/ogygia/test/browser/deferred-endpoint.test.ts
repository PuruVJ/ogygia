// DEFERRED HOLE on a Kit-hydrated (csr=true) document, in a real browser. The wrapper's client leg
// cannot mint a capability (the region-endpoint virtual is stubbed to '' in the client build), so
// Kit's hydration pass reconciles the server-minted `endpoint` attribute to '' — after the runtime
// saw it at parse time. The runtime keeps its own copy and restores the attribute; the hole still
// fetches. Found on a real header whose personal bits are server islands under a csr=true page:
// every hole stayed on its fallback, with no request at all.
import { expect, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';

const ENDPOINT = '/__ogygia__?id=deadbeef0000&props=W3t9XQ&exp=9999999999&sig=stub';

function html_response(html: string): Response {
	const res = new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
	// A constructed Response has no `url`; the runtime's same-origin check reads it.
	Object.defineProperty(res, 'url', { value: location.origin + ENDPOINT });
	return res;
}

test('a deferred hole survives Kit wiping its endpoint attribute after connect', async () => {
	document.body.innerHTML =
		`<ogygia-region render="defer" when="idle" endpoint="${ENDPOINT}">` +
		`<p data-testid="fallback">fallback</p></ogygia-region>`;
	const region = document.querySelector('ogygia-region')!;
	const calls: string[] = [];
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		return html_response('<p data-testid="served">served</p>');
	};
	try {
		bootDev(); // defines <ogygia-region>; connect captures the minted endpoint and arms `idle`
		// Kit's hydration, a moment later: the client leg renders `endpoint=""`.
		region.setAttribute('endpoint', '');
		await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('/__ogygia__?id=deadbeef0000');
		expect(region.getAttribute('endpoint')).toBe(ENDPOINT);
		expect(document.querySelector('[data-testid="served"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="fallback"]')).toBeNull();
	} finally {
		window.fetch = real_fetch;
	}
});

// ON-DEMAND hole (`when="interaction"`): nothing is fetched until intent lands inside the region;
// then the HTML is MORPHED in — the fallback's nodes (and what the visitor opened in them) survive.
// A site mega menu: the page carries L1/L2, the pointer entering the nav fetches L3/L4.
// Its own endpoint id: the frame store keeps a fetched frame per address, and the first test's
// address would replay from that cache without a request.
const ON_DEMAND_ENDPOINT = '/__ogygia__?id=cafebabe0001&props=W3t9XQ&exp=9999999999&sig=stub';

test('an on-demand hole fetches on pointer intent and morphs its HTML in (fallback nodes survive)', async () => {
	const calls: string[] = [];
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		const res = new Response(
			'<ul data-testid="menu"><li id="l1" data-open="true">Products<ul><li data-testid="l3">Drives</li></ul></li></ul>',
			{ status: 200, headers: { 'content-type': 'text/html' } }
		);
		Object.defineProperty(res, 'url', { value: location.origin + ON_DEMAND_ENDPOINT });
		return res;
	};
	document.body.innerHTML =
		`<ogygia-region render="defer" when="interaction" endpoint="${ON_DEMAND_ENDPOINT}">` +
		`<ul data-testid="menu"><li id="l1" data-open="true">Products</li></ul></ogygia-region>`;
	const region = document.querySelector('ogygia-region')!;
	const l1_before = document.getElementById('l1')!;
	try {
		bootDev();
		await new Promise((r) => setTimeout(r, 300));
		expect(calls).toHaveLength(0); // no intent, no request
		expect(region.hasAttribute('data-hydrated')).toBe(false);
		region.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
		await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(calls).toHaveLength(1);
		expect(document.querySelector('[data-testid="l3"]')).not.toBeNull(); // L3 arrived
		expect(document.getElementById('l1')).toBe(l1_before); // morphed: the L1 node survived
		expect(document.getElementById('l1')!.getAttribute('data-open')).toBe('true');
	} finally {
		window.fetch = real_fetch;
	}
});

// INTENT RADIUS: `margin` on an on-demand hole fetches when the pointer comes that close to the
// region's box — the region is `display: contents`, so the box is its children's.
const RADIUS_ENDPOINT = '/__ogygia__?id=cafebabe0002&props=W3t9XQ&exp=9999999999&sig=stub';

test('an on-demand hole with a margin fetches when the pointer approaches its content', async () => {
	const calls: string[] = [];
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		const res = new Response(
			'<div id="box" style="position:fixed;top:0;left:0;width:200px;height:40px">menu with L3</div>',
			{
				status: 200,
				headers: { 'content-type': 'text/html' }
			}
		);
		Object.defineProperty(res, 'url', { value: location.origin + RADIUS_ENDPOINT });
		return res;
	};
	document.body.innerHTML =
		`<ogygia-region render="defer" when="interaction" margin="150px" style="display:contents" endpoint="${RADIUS_ENDPOINT}">` +
		`<div id="box" style="position:fixed;top:0;left:0;width:200px;height:40px">menu</div></ogygia-region>`;
	const region = document.querySelector('ogygia-region')!;
	try {
		bootDev();
		await new Promise((r) => setTimeout(r, 200));
		// far away: 400px below the box — no intent
		document.dispatchEvent(
			new PointerEvent('pointermove', { clientX: 100, clientY: 440, bubbles: true })
		);
		await new Promise((r) => setTimeout(r, 200));
		expect(calls).toHaveLength(0);
		// within 150px below the box — intent
		document.dispatchEvent(
			new PointerEvent('pointermove', { clientX: 100, clientY: 150, bubbles: true })
		);
		await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(calls).toHaveLength(1);
		expect(document.getElementById('box')!.textContent).toBe('menu with L3');
	} finally {
		window.fetch = real_fetch;
	}
});

// KEEP THE FALLBACK: the hole answers 204 (`keepFallback()` on the server) — the page's fallback
// stays as it is, the region is marked done, nothing is swapped.
const KEEP_ENDPOINT = '/__ogygia__?id=cafebabe0003&props=W3t9XQ&exp=9999999999&sig=stub';

test('a hole answering 204 keeps the page fallback and marks the region done', async () => {
	const calls: string[] = [];
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		const res = new Response(null, { status: 204 });
		Object.defineProperty(res, 'url', { value: location.origin + KEEP_ENDPOINT });
		return res;
	};
	document.body.innerHTML =
		`<ogygia-region render="defer" when="load" endpoint="${KEEP_ENDPOINT}">` +
		`<p data-testid="fallback">anonymous actions</p></ogygia-region>`;
	const region = document.querySelector('ogygia-region')!;
	const fallback = document.querySelector('[data-testid="fallback"]');
	try {
		bootDev();
		await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(calls).toHaveLength(1);
		expect(region.hasAttribute('data-og-kept')).toBe(true);
		expect(document.querySelector('[data-testid="fallback"]')).toBe(fallback); // untouched
	} finally {
		window.fetch = real_fetch;
	}
});
