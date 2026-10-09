// A DEFERRED hole's answer swaps over a fallback that a foreign runtime has already made interactive.
// A menu's deeper links are a `render:'deferred' wake:'idle'` hole; its top-level fallback is on screen
// and its `<x-menu-item>` (a web component) upgrades ~1 s after DCL — a visitor can OPEN it (the
// runtime sets state on the item's shadow root) before the idle answer lands seconds later. #apply
// used to `replaceChildren` for every non-`interaction` hole, destroying the opened item and
// re-inserting a fresh closed one: the open menu vanished and the just-arrived deeper links were never
// shown (field, 5/5). #apply now MORPHS every hole — morph keys on `id`, the fallback and answer share
// the shell id, so the opened element keeps its identity (shadow root + open state) and the answer's
// deeper links graft under it. This pins that, and that the plain-fallback (nothing-to-keep) hole fills.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';

const ENDPOINT = '/__ogygia__?id=deadbeef1234&props=W3t9XQ&exp=9999999999&sig=stub';
// A distinct id: the runtime keys a hole's fetch/frame by the endpoint id, so a second hole reusing
// the first's id would ride the cached frame and never fetch.
const ENDPOINT2 = '/__ogygia__?id=deadbeef5678&props=W3t9XQ&exp=9999999999&sig=stub';
// The answer renders the SAME top-level shell id as the fallback, plus the deeper links it never had.
const ANSWER =
	'<x-menu-item id="mm-top-0"><span data-top>Top</span>' +
	'<a id="mm-deep-a" data-deep href="#">Deep A</a><a id="mm-deep-b" data-deep href="#">Deep B</a></x-menu-item>';

let real_fetch: typeof fetch;
let fetched: string[];
let release_answer: () => void;

beforeEach(() => {
	fetched = [];
	real_fetch = globalThis.fetch;
	// Hold the answer until the test releases it — the field window where the fallback is upgraded
	// and opened BEFORE the answer lands.
	globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		fetched.push(url);
		return new Promise<Response>((resolve) => {
			release_answer = () =>
				resolve(new Response(ANSWER, { status: 200, headers: { 'content-type': 'text/html' } }));
		});
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = real_fetch;
	document.body.innerHTML = '';
});

test('a hole answer morphs over an already-upgraded, already-open fallback: identity + open state survive, deeper links graft in', async () => {
	document.body.innerHTML =
		`<ogygia-region render="defer" when="load" endpoint="${ENDPOINT}" data-og-hole="mm">` +
		'<x-menu-item id="mm-top-0"><span data-top>Top</span></x-menu-item>' +
		'</ogygia-region>';
	const region = document.querySelector('ogygia-region') as HTMLElement;

	bootDev();
	await expect.poll(() => fetched.length, { timeout: 10_000 }).toBe(1);

	// The foreign runtime upgrades the fallback item and the visitor opens it — BEFORE the answer.
	const item = region.querySelector('#mm-top-0') as HTMLElement;
	item.attachShadow({ mode: 'open' }); // upgraded → self-owned
	item.setAttribute('data-open', 'true'); // the state the component set when it opened
	(item as unknown as { __live: symbol }).__live = Symbol('same-instance'); // identity witness

	release_answer();

	// The deeper links the answer brought are grafted in…
	await expect.poll(() => region.querySelector('#mm-deep-a') != null, { timeout: 10_000 }).toBe(true);
	// …WITHOUT replacing the opened item: same element instance, its shadow root and open state intact.
	const after = region.querySelector('#mm-top-0') as HTMLElement;
	expect(after, 'same element instance — not re-created').toBe(item);
	expect((after as unknown as { __live?: symbol }).__live, 'identity witness survived').toBe(
		(item as unknown as { __live: symbol }).__live
	);
	expect(after.shadowRoot, 'the upgrade (shadow root) survived').not.toBeNull();
	expect(after.getAttribute('data-open'), 'the open state survived the swap').toBe('true');
	expect(region.querySelector('#mm-deep-b'), 'the second deeper link grafted too').not.toBeNull();
	expect(after.querySelector('[data-top]')?.textContent, 'the top-level label is intact').toBe('Top');
});

test('a plain placeholder fallback (nothing to keep) still fills from the answer', async () => {
	document.body.innerHTML =
		`<ogygia-region render="defer" when="load" endpoint="${ENDPOINT2}" data-og-hole="mm2">` +
		'<div data-fallback>loading</div>' +
		'</ogygia-region>';
	const region = document.querySelector('ogygia-region') as HTMLElement;

	bootDev();
	await expect.poll(() => fetched.length, { timeout: 10_000 }).toBe(1);
	release_answer();

	await expect.poll(() => region.querySelector('#mm-top-0') != null, { timeout: 10_000 }).toBe(true);
	expect(region.querySelector('[data-fallback]'), 'the placeholder is gone').toBeNull();
	expect(region.querySelector('#mm-deep-a'), 'the answer content is in').not.toBeNull();
});
