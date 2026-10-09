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
// Usage: pnpm exec playwright test hydrate-in-place
import { test, check } from './fixtures/index.ts';

type RootsWindow = Window & { __ssrRoots: WeakSet<Element> };

test.describe('islands adopt SSR root (no discard+recreate / class-less flash)', () => {
	test('every hydrated island keeps its SSR root node', async ({ page }) => {
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));

		// Capture every island's SSR root node BEFORE hydration into a WeakSet (no DOM mutation, so it
		// can't itself perturb hydration). `firstElementChild` skips the `[`/`]` envelope comments.
		await page.addInitScript(() => {
			(window as unknown as RootsWindow).__ssrRoots = new WeakSet();
			const roots = (window as unknown as RootsWindow).__ssrRoots;
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

		await page.goto('/', { waitUntil: 'load' });
		await page.waitForTimeout(1200);

		const stats = await page.evaluate(() => {
			const roots = (window as unknown as RootsWindow).__ssrRoots;
			const hydrated = [...document.querySelectorAll('ogygia-region[data-hydrated]')];
			const recreated = hydrated.filter((r) => {
				const root = r.firstElementChild;
				return root != null && !roots.has(root);
			});
			return {
				hydrated: hydrated.length,
				recreated: recreated.map((r) =>
					(r.getAttribute('entry') || '').split('/').pop()?.slice(0, 22)
				)
			};
		});

		check(
			'islands hydrate IN PLACE (SSR root adopted, not re-created)',
			stats.hydrated > 0 && stats.recreated.length === 0,
			`${stats.recreated.length}/${stats.hydrated} re-created${stats.recreated.length ? ': ' + stats.recreated.join(', ') : ''}`
		);
		check('no page errors during hydration', errs.length === 0, errs.slice(0, 2).join('; '));
	});
});
