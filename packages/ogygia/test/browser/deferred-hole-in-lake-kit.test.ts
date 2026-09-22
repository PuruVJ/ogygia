// A render:'deferred' HOLE inside a wake:'none' LAKE, on a Kit-hydrated (csr=true) document, in a real
// browser. This is the shared-header shape: the header is a lake, imported in a layout that renders on
// both csr=false catch-all routes and csr=true routes. On csr=false the holes fetch their signed
// endpoint and morph the answer in. On csr=true they must too — Kit adopts the lake as opaque DOM, so
// the holes are ogygia's and nothing else will ever fill them. The bug this pins: a deferred hole inside
// a lake never fetched on a csr=true page (it stayed on its fallback with no request), so its
// server-primed content never arrived.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';

const ENDPOINT = '/__ogygia__?id=deadbeef0001&props=W3t9XQ&exp=9999999999&sig=stub';
const ANSWER = '<div data-testid="hole-content">FILLED</div>';

let real_fetch: typeof fetch;
let fetched: string[];

beforeEach(() => {
	fetched = [];
	real_fetch = globalThis.fetch;
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		fetched.push(url);
		return new Response(ANSWER, { status: 200, headers: { 'content-type': 'text/html' } });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = real_fetch;
	document.head.querySelectorAll('meta[name="ogygia-csr"]').forEach((m) => m.remove());
	document.body.innerHTML = '';
});

function set_csr_true(): void {
	const meta = document.createElement('meta');
	meta.setAttribute('name', 'ogygia-csr');
	meta.setAttribute('content', 'true');
	document.head.appendChild(meta);
}

test('a deferred hole INSIDE a lake fetches and fills on a csr=true document', async () => {
	set_csr_true();
	// The header lake (wake:'none') with a deferred hole inside — exactly the served shape.
	document.body.innerHTML =
		'<ogygia-region wake="none" entry="header-lake">' +
		'  <div data-frozen>shell</div>' +
		`  <ogygia-region render="defer" when="load" endpoint="${ENDPOINT}" data-og-hole="hole1">` +
		'    <div data-fallback>loading</div>' +
		'  </ogygia-region>' +
		'</ogygia-region>';

	bootDev();

	// The hole must FETCH its endpoint and morph the answer in.
	await expect
		.poll(() => fetched.some((u) => u.includes('/__ogygia__')), { timeout: 10_000 })
		.toBe(true);
	await expect
		.poll(() => document.querySelector('[data-testid="hole-content"]')?.textContent, {
			timeout: 10_000
		})
		.toBe('FILLED');
});
