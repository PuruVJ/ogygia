// THE SAME PAGE, RENDERED TWICE, IS THE SAME: an island with children carries a slot pointer in its
// props, whose ref id was a random UUID and whose slot id counted across the whole page — so every
// island with children changed its fingerprint (`data-og-fp`, what the router reconciles by) and its
// bytes on every request, missing every cache keyed on them. Now the snippet's id comes from its
// descriptor and slot ids count per island.
//
//   pnpm exec playwright test render-determinism
import { test, check } from './fixtures/index.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const attrs = (html: string, name: string) => [...html.matchAll(new RegExp(`${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

for (const path of ['/island-children', '/snippet-islands', '/snippet-in-place']) {
	test(`${path}: two renders, the same fingerprints and slot ids, no random ids`, async ({ baseURL }) => {
		const a = await (await fetch(baseURL + path)).text();
		const b = await (await fetch(baseURL + path)).text();
		const fp_a = attrs(a, 'data-og-fp');
		check('the page has islands', fp_a.length > 0, String(fp_a.length));
		check('the same island fingerprints', JSON.stringify(fp_a) === JSON.stringify(attrs(b, 'data-og-fp')), `${fp_a.join(',')} vs ${attrs(b, 'data-og-fp').join(',')}`);
		check('the same slot ids', JSON.stringify(attrs(a, 'data-og-slot')) === JSON.stringify(attrs(b, 'data-og-slot')));
		check('no random ids in the page', !UUID.test(a), a.match(UUID)?.[0] ?? '');
	});
}
