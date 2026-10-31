// WHAT KIT NEVER HYDRATES (region-attrs.ts `OPAQUE_SELECTOR`): on a Kit-hydrated document an island
// is Kit's — except inside a region whose inside Kit's hydration never walks: a lake, a hole (its
// fetched answer), and a BAKED live region (its first HTML is server-only). Those islands are the
// runtime's. A baked region's were handed to Kit (`data-kit-hydrated`) whenever they woke before the
// region's first `applyLive` had marked it a hole — a field header's islands, 7 of 8, stayed inert.
import { afterEach, expect, test } from 'vitest';
import { ours_on_kit_document } from '../../src/runtime/region-attrs.ts';

afterEach(() => {
	document.body.innerHTML = '';
});

const island = '<ogygia-region wake="load" data-island></ogygia-region>';

test('an island inside a lake, a hole, or a baked live region is the runtime’s on a Kit document', () => {
	for (const open of [
		'<ogygia-region wake="none">',
		'<ogygia-region render="defer" when="load">',
		'<ogygia-region live data-og-baked>'
	]) {
		document.body.innerHTML = `${open}<div>${island}</div></ogygia-region>`;
		expect(ours_on_kit_document(document.querySelector('[data-island]')!), open).toBe(true);
	}
});

test('an island in Kit’s own tree, or inside a live region not baked, stays Kit’s', () => {
	document.body.innerHTML = `<main>${island}</main>`;
	expect(ours_on_kit_document(document.querySelector('[data-island]')!)).toBe(false);
	document.body.innerHTML = `<ogygia-region live>${island}</ogygia-region>`;
	expect(ours_on_kit_document(document.querySelector('[data-island]')!)).toBe(false);
});

test('a hole itself is the runtime’s', () => {
	document.body.innerHTML = '<ogygia-region render="defer" when="load" data-hole></ogygia-region>';
	expect(ours_on_kit_document(document.querySelector('[data-hole]')!)).toBe(true);
});
