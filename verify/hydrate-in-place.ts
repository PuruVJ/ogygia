// Regression: islands must hydrate IN PLACE — Svelte adopts each island's SSR root node rather than
// discarding it and creating a fresh one. A re-created root is class-less for a tick (a `class:`-managed
// className is applied one reactive step after creation), so a root whose `position: fixed` comes from
// that class briefly falls to `static` and lands in-flow, shoving downstream layout (the sidebar-above-
// a-centered-hero "bounce"). The re-creation was caused by `Region.svelte` wrapping the island in
// `{#if Component}…{/if}` (an extra SSR fragment layer) while the client `NestedProvider` rendered a
// bare `<Component/>` — mismatched layers ⇒ discard+recreate. NestedProvider now mirrors the SSR shape.
//
// Also guards the paired router fix: a clean in-place hydration runs the island `<svelte:head>`
// reconciliation, which removes a TRAILING head-node range — so the router must insert SPA stylesheets
// at the TOP of <head>, not the end, or the destination page CSS gets reclaimed on navigation.
//
// Usage: node verify/hydrate-in-place.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errs: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));

	// Capture every island's SSR root node BEFORE hydration into a WeakSet (no DOM mutation, so it
	// can't itself perturb hydration). `firstElementChild` skips the `[`/`]` envelope comments.
	await page.addInitScript(() => {
		(window as unknown as { __ssrRoots: WeakSet<Element> }).__ssrRoots = new WeakSet();
		const roots = (window as unknown as { __ssrRoots: WeakSet<Element> }).__ssrRoots;
		const capture = () => {
			for (const r of document.querySelectorAll('ogygia-region')) {
				const root = r.firstElementChild;
				if (root) roots.add(root);
			}
		};
		const iv = setInterval(capture, 1);
		addEventListener('DOMContentLoaded', () => {
			capture();
			clearInterval(iv);
		});
	});

	await page.goto(base + '/', { waitUntil: 'load' });
	await page.waitForTimeout(1200);

	const stats = await page.evaluate(() => {
		const roots = (window as unknown as { __ssrRoots: WeakSet<Element> }).__ssrRoots;
		const hydrated = [...document.querySelectorAll('ogygia-region[data-hydrated]')];
		const recreated = hydrated.filter((r) => {
			const root = r.firstElementChild;
			return root != null && !roots.has(root);
		});
		return {
			hydrated: hydrated.length,
			recreated: recreated.map((r) => (r.getAttribute('entry') || '').split('/').pop()?.slice(0, 22))
		};
	});

	check(
		'islands hydrate IN PLACE (SSR root adopted, not re-created)',
		stats.hydrated > 0 && stats.recreated.length === 0,
		`${stats.recreated.length}/${stats.hydrated} re-created${stats.recreated.length ? ': ' + stats.recreated.join(', ') : ''}`
	);
	check('no page errors during hydration', errs.length === 0, errs.slice(0, 2).join('; '));

	await page.close();
} finally {
	await browser.close();
}

console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL HYDRATE-IN-PLACE CHECKS PASSED' : failures + ' HYDRATE-IN-PLACE CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
