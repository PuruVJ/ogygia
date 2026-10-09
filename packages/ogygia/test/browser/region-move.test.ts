// A MOVE IS NOT A REMOVAL (runtime/core.ts disconnectedCallback). Another script relocating a region
// disconnects and reconnects it in one task — a custom element that, at its upgrade, takes the
// children its server render placed inside its markup into a shadow root and appends them back to
// its own light DOM. The region's teardown waits a microtask and runs only if it is still out.
//
// REGRESSION (field report on ce3b3026): a header mega-menu hole (`when: 'idle'`) inside such
// elements was sometimes fetched twice — the move aborted its in-flight request, the reconnect
// re-armed its idle wake, and a second request went out 250–740 ms later.
import { expect, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';

const ENDPOINT = '/__ogygia__?id=feedface0002&props=W3t9XQ&exp=9999999999&sig=stub';

function held_fetch() {
	const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const real = window.fetch;
	window.fetch = async (input, init) => {
		calls.push({ url: String(input), signal: init?.signal });
		await gate;
		init?.signal?.throwIfAborted();
		const res = new Response('<p data-testid="served">served</p>', {
			status: 200,
			headers: { 'content-type': 'text/html' }
		});
		Object.defineProperty(res, 'url', { value: location.origin + ENDPOINT });
		return res;
	};
	return { calls, release, restore: () => (window.fetch = real) };
}

test('a hole moved while its fetch is in flight keeps that fetch, and fills once', async () => {
	const net = held_fetch();
	document.body.innerHTML =
		`<div data-from><ogygia-region render="defer" when="load" endpoint="${ENDPOINT}"><p data-testid="fallback">fallback</p></ogygia-region></div>` +
		'<div data-host></div><div data-to></div>';
	try {
		bootDev();
		await expect.poll(() => net.calls.length, { timeout: 10_000 }).toBe(1);
		const region = document.querySelector('ogygia-region')!;
		// the relocation, as such an element does it at its upgrade: into its shadow root, then back
		// out into its light DOM — two moves, one task
		const shadow = (document.querySelector('[data-host]') as HTMLElement).attachShadow({ mode: 'open' });
		shadow.append(region);
		document.querySelector('[data-to]')!.append(region);
		await new Promise((r) => setTimeout(r, 50));
		expect(net.calls[0].signal?.aborted, 'the move did not abort the request').toBe(false);
		net.release();
		await expect.poll(() => region.querySelector('[data-testid="served"]'), { timeout: 10_000 }).not.toBeNull();
		await new Promise((r) => setTimeout(r, 100));
		expect(net.calls.length, 'one request').toBe(1);
	} finally {
		net.restore();
	}
});

test('a hole removed for good still aborts its fetch', async () => {
	const net = held_fetch();
	document.body.innerHTML = `<ogygia-region render="defer" when="load" endpoint="${ENDPOINT.replace('feedface0002', 'feedface0003')}"><p>fallback</p></ogygia-region>`;
	try {
		bootDev();
		await expect.poll(() => net.calls.length, { timeout: 10_000 }).toBe(1);
		document.querySelector('ogygia-region')!.remove();
		await expect.poll(() => net.calls[0].signal?.aborted, { timeout: 2_000 }).toBe(true);
	} finally {
		net.release();
		net.restore();
	}
});
