// A deferred HOLE on a KIT-HYDRATED (csr=true) document, in a real browser. Kit hydrates the whole
// document — `hydrate()` over the SSR DOM, exactly what this test does — and the browser cannot mint a
// hole's signed address. As a template, the hole's `endpoint` was a dynamic attribute Svelte SET during
// hydration — to '' — and HTML that had already landed in the hole went with it: a hole inside an inline
// island on a csr=true page went empty (dev, timing-dependent). The wrapper's client leg ADOPTS the
// server element verbatim instead: address and content survive.
import { afterEach, expect, inject, test } from 'vitest';
import { hydrate, unmount } from 'svelte';
import HoleKitHost from './fixtures/HoleKitHost.svelte';

const inject_html = (key: 'hole_kit_ssr_b64') => decodeURIComponent(escape(atob(inject(key))));

afterEach(() => {
	document.body.innerHTML = '';
});

test('Kit hydration adopts the hole verbatim: its address and landed HTML survive', () => {
	document.body.innerHTML =
		'<script>__sveltekit_lab = {};</script><div data-mount>' +
		inject_html('hole_kit_ssr_b64') +
		'</div>';
	const mount = document.querySelector('[data-mount]') as HTMLElement;
	const hole = document.querySelector('ogygia-region[render="defer"]') as HTMLElement;
	expect(hole, 'the server rendered the hole').not.toBeNull();
	expect(hole.hasAttribute('endpoint'), 'the server rendered its address slot').toBe(true);
	// (no signing secret in this harness: give it the address a real server signs)
	const endpoint = '/__ogygia__?id=hole-kit&props=W3t9XQ&exp=9999999999&sig=stub';
	hole.setAttribute('endpoint', endpoint);
	// the hole's HTML landed before Kit hydrated (the runtime fetched it during the parse)
	hole.innerHTML = '<p data-landed>landed</p>';

	const warns: string[] = [];
	const real_warn = console.warn;
	console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '));
	let app: unknown;
	try {
		app = hydrate(HoleKitHost, { target: mount });
	} finally {
		console.warn = real_warn;
	}
	expect(document.querySelector('ogygia-region[render="defer"]'), 'the same element, adopted').toBe(
		hole
	);
	expect(hole.getAttribute('endpoint'), 'its address kept').toBe(endpoint);
	expect(hole.querySelector('[data-landed]'), 'its landed HTML kept').not.toBeNull();
	expect(warns.filter((w) => w.includes('hydration_mismatch'))).toEqual([]);
	unmount(app as never);
});
