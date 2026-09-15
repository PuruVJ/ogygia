// DEFERRED HOLE on a Kit-hydrated (csr=true) document, in a real browser. The wrapper's client leg
// cannot mint a capability (the region-endpoint virtual is stubbed to '' in the client build), so
// Kit's hydration pass reconciles the server-minted `endpoint` attribute to '' — after the runtime
// saw it at parse time. The runtime keeps its own copy and restores the attribute; the hole still
// fetches. Found on a real header whose personal bits are server islands under a csr=true page:
// every hole stayed on its fallback, with no request at all.
import { beforeEach, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { bootDev } from '../../src/runtime/full.js';

/**
 * Park the REAL pointer in the bottom-right corner before every test. An on-demand hole warms on
 * `pointerover`, and Chromium fires a TRUSTED `pointerover` on content that appears under a resting
 * cursor (its post-layout fake mouse move) — so a fixture inserted at the top-left while the
 * runner's pointer rests there is "hovered" the instant `innerHTML` lands, and the hole fetches
 * before the test's own hover. That is correct runtime behaviour (a real cursor IS over the nav)
 * and a wrong test assumption; it only ever showed on CI, where the pointer rests at (0,0), and
 * read as an "upstream break" on the weekly watcher twice. Proven by parking the pointer over the
 * fixture on a passing machine: same trusted event, same early fetch.
 */
async function park_pointer(): Promise<void> {
	// A real, hoverable target: Playwright's actionability check rejects a 1px box flush at the
	// viewport edge (its hover point rounds outside the viewport) and waits out the action timeout —
	// every test then dies in this hook. 24px, inset 24px from the corner, is unambiguous and still
	// hundreds of pixels from any top-left fixture (and any warm margin).
	const corner = document.createElement('div');
	corner.style.cssText = 'position:fixed;right:24px;bottom:24px;width:24px;height:24px';
	document.body.appendChild(corner);
	await userEvent.hover(corner);
	corner.remove();
}
beforeEach(park_pointer);

// REGRESSION for the mechanism above, self-contained: put the real pointer exactly where the
// on-demand fixture will render (the CI resting position), apply the park, insert the fixture. With
// the pointer parked, no trusted `pointerover` reaches the hole and nothing is fetched; without it,
// this fixture fetched before any hover on every scheduled CI run.
const RESTING_ENDPOINT = '/__ogygia__?id=cafebabe0009&props=W3t9XQ&exp=9999999999&sig=stub';

test('an on-demand hole is not warmed by a pointer that merely RESTS where its content appears', async () => {
	// the adversarial condition: the real pointer over the spot the fixture's first element lands
	const over_fixture = document.createElement('div');
	over_fixture.style.cssText = 'position:fixed;left:6px;top:6px;width:12px;height:12px';
	document.body.appendChild(over_fixture);
	await userEvent.hover(over_fixture);
	over_fixture.remove();
	await park_pointer(); // the defence every test in this file gets from beforeEach

	const calls: string[] = [];
	// Only a trusted pointerover INSIDE the region can warm the hole. (Chromium does fire one on the
	// body under the parked pointer when the DOM changes — that is the mechanism, and it is harmless
	// there; the defence is that it never lands inside the region.)
	const trusted_overs: string[] = [];
	const on_over = (e: Event) => {
		const target = e.target as Element;
		if (e.isTrusted && target.closest?.('ogygia-region')) trusted_overs.push(target.tagName);
	};
	document.addEventListener('pointerover', on_over, true);
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		return new Response('<a id="rest">served</a>', {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});
	};
	document.body.innerHTML =
		`<nav><ogygia-region render="defer" when="interaction" style="display:contents" endpoint="${RESTING_ENDPOINT}">` +
		`<a id="rest">Products</a></ogygia-region></nav>`;
	try {
		bootDev();
		await new Promise((r) => setTimeout(r, 200));
		expect(trusted_overs, `trusted pointerover inside the region on: ${trusted_overs.join(', ')}`).toHaveLength(0);
		expect(calls, `fetched with no hover: ${calls.join(' | ')}`).toHaveLength(0);
	} finally {
		document.removeEventListener('pointerover', on_over, true);
		window.fetch = real_fetch;
	}
});

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
		expect(calls, `fetched before any intent: ${calls.join(' | ')}`).toHaveLength(0); // no intent, no request
		expect(region.hasAttribute('data-hydrated')).toBe(false);
		region.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
		await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(calls).toHaveLength(1);
		expect(document.querySelector('[data-testid="l3"]')).not.toBeNull(); // L3 arrived
		expect(document.getElementById('l1')).toBe(l1_before); // morphed: the L1 node survived
		expect(document.getElementById('l1')!.getAttribute('data-open')).toBe('true');
	} finally {
		window.fetch = real_fetch;
	}
});

// HOVER via a DESCENDANT: `pointerover` bubbles, so hovering a child of the boxless
// (`display: contents`) wrapper triggers the fetch — before any click. This is the mega-menu case:
// the wrapper has no box of its own, the nav items inside do.
const HOVER_ENDPOINT = '/__ogygia__?id=cafebabe0002&props=W3t9XQ&exp=9999999999&sig=stub';

test('an on-demand hole fetches on hover of a descendant (pointerover bubbles through display:contents)', async () => {
	const calls: string[] = [];
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		const res = new Response('<a id="item">Products — with L3</a>', {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});
		Object.defineProperty(res, 'url', { value: location.origin + HOVER_ENDPOINT });
		return res;
	};
	document.body.innerHTML =
		`<nav><ogygia-region render="defer" when="interaction" style="display:contents" endpoint="${HOVER_ENDPOINT}">` +
		`<a id="item">Products</a></ogygia-region></nav>`;
	const region = document.querySelector('ogygia-region')!;
	const item = document.getElementById('item')!;
	try {
		bootDev();
		await new Promise((r) => setTimeout(r, 200));
		expect(calls, `fetched before the hover: ${calls.join(' | ')}`).toHaveLength(0); // no hover yet
		// hover the descendant <a>; pointerover bubbles up through the boxless wrapper
		item.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
		await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(calls).toHaveLength(1);
		expect(document.getElementById('item')!.textContent).toBe('Products — with L3');
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

// SELF-OWNED ATTRIBUTES through a hole morph: a web component writes `popover="manual"` onto its
// own host at upgrade and opens through `showPopover()` (the top layer). The fetched HTML never
// carried `popover`; the morph must not take it away — the country selector's dropdown fell out of
// the top layer this way. Real custom element, real popover API, real on-demand hole.
// its own id: the frame store keeps a fetched frame per address, and 0003 above is a stored 204.
const POPOVER_ENDPOINT = '/__ogygia__?id=cafebabe0004&props=W3t9XQ&exp=9999999999&sig=stub';

test('a hole morph keeps the attributes a web component gave itself (popover stays open)', async () => {
	if (!customElements.get('x-pop')) {
		customElements.define(
			'x-pop',
			class extends HTMLElement {
				connectedCallback() {
					this.setAttribute('popover', 'manual'); // what QDS's dropdown does at upgrade
				}
			}
		);
	}
	const calls: string[] = [];
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		const res = new Response(
			'<div><button id="t">France</button><x-pop id="p" class="qds-related" data-x="1"><ul id="list"><li>Albania</li></ul></x-pop></div>',
			{ status: 200, headers: { 'content-type': 'text/html' } }
		);
		Object.defineProperty(res, 'url', { value: location.origin + POPOVER_ENDPOINT });
		return res;
	};
	document.body.innerHTML =
		`<ogygia-region render="defer" when="interaction" endpoint="${POPOVER_ENDPOINT}">` +
		`<div><button id="t">France</button><x-pop id="p" class="qds-related"></x-pop></div></ogygia-region>`;
	const region = document.querySelector('ogygia-region')!;
	const pop = document.getElementById('p') as HTMLElement;
	try {
		bootDev();
		expect(pop.getAttribute('popover'), 'the element gave itself popover at upgrade').toBe('manual');
		pop.showPopover();
		expect(pop.matches(':popover-open')).toBe(true);
		region.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
		await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(calls).toHaveLength(1);
		expect(document.getElementById('p')).toBe(pop); // morphed in place
		expect(pop.getAttribute('popover'), 'the morph took the attribute the element gave itself').toBe('manual');
		expect(pop.matches(':popover-open'), 'the popover fell out of the top layer').toBe(true);
		expect(pop.getAttribute('data-x')).toBe('1'); // the render's attributes still land
		expect(document.getElementById('list')).not.toBeNull(); // and its content
	} finally {
		try { pop.hidePopover(); } catch { /* already hidden */ }
		window.fetch = real_fetch;
	}
});

// PREFETCH: `prefetch="idle"` on an on-demand hole warms its HTML at idle — one request, NOTHING
// applied (the fallback stands, no `data-hydrated`) — and the first hover then swaps from the store
// without a second request. The country selector's "5 s hover": the bytes are already there.
const PREFETCH_ENDPOINT = '/__ogygia__?id=cafebabe0005&props=W3t9XQ&exp=9999999999&sig=stub';

test('an on-demand hole with prefetch="idle" warms at idle, keeps its fallback, and swaps on hover with no second request', async () => {
	const calls: string[] = [];
	const real_fetch = window.fetch;
	window.fetch = async (input) => {
		calls.push(String(input));
		const res = new Response('<ul data-testid="menu"><li id="l1">Products<ul><li data-testid="l3">Drives</li></ul></li></ul>', {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});
		Object.defineProperty(res, 'url', { value: location.origin + PREFETCH_ENDPOINT });
		return res;
	};
	document.body.innerHTML =
		`<ogygia-region render="defer" when="interaction" prefetch="idle" endpoint="${PREFETCH_ENDPOINT}">` +
		`<ul data-testid="menu"><li id="l1">Products</li></ul></ogygia-region>`;
	const region = document.querySelector('ogygia-region')!;
	const l1_before = document.getElementById('l1')!;
	try {
		bootDev();
		// idle fires within the rIC timeout: the warm request goes out with no intent at all
		await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
		await new Promise((r) => setTimeout(r, 300));
		expect(region.hasAttribute('data-hydrated'), 'a prefetch must not swap').toBe(false);
		expect(document.querySelector('[data-testid="l3"]'), 'a prefetch must not swap').toBeNull();
		// intent: the swap joins the warm frame — no second request
		region.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
		await expect.poll(() => region.hasAttribute('data-hydrated'), { timeout: 10_000 }).toBe(true);
		expect(calls, 'the hover must join the warm frame, not fetch again').toHaveLength(1);
		expect(document.querySelector('[data-testid="l3"]')).not.toBeNull();
		expect(document.getElementById('l1')).toBe(l1_before); // still a morph: the fallback's node survived
	} finally {
		window.fetch = real_fetch;
	}
});
