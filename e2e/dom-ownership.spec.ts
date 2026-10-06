// DOM OWNERSHIP — a web component's own light DOM survives the island's wake.
//
// REGRESSION (a field report, 2026-10-06): an island server-renders a third-party search widget; the
// widget's definition loads before the island wakes, and on upgrade it prepends a backdrop and appends
// a suggestions pane to its own light DOM. The pre-hydration repair recursed into the widget and
// stripped both (search suggestions dead). Under the ownership model (runtime/ownership.ts) Svelte's
// hydration never walks a widget inside `{@html}` or a custom element with static children; the
// compiler stamps those hosts, and the repair, drift watch and morph leave them alone.
//
// Guards, for both shapes on one island:
//   (1) the server markup carries the compiler's stamp on both hosts;
//   (2) after the widget upgraded and the island woke: every widget node kept, same identity;
//   (3) the island hydrated (no recovery) and works.
// Usage: pnpm exec playwright test dom-ownership
import { test, check } from './fixtures/index.ts';

test.describe('DOM OWNERSHIP: a widget’s own nodes survive the wake', () => {
	test('SSR: both widget hosts carry the compiler’s opaque stamp', async ({ baseURL }) => {
		const html = await (await fetch(baseURL + '/dom-ownership')).text();
		check('{@html} host stamped', /<div class="widget-host[^"]*"[^>]*data-og-opaque|<div data-og-opaque[^>]*class="widget-host/.test(html), html.slice(html.indexOf('widget-host') - 80, html.indexOf('widget-host') + 80));
		check('static custom element stamped', /<x-guided-e2e data-og-opaque[^>]*data-variant="static"|<x-guided-e2e[^>]*data-variant="static"[^>]*data-og-opaque/.test(html));
		check('{@html} beside walked content: parent stamped data-og-html', /<div data-og-html[^>]*class="widget-mixed|<div class="widget-mixed[^"]*"[^>]*data-og-html/.test(html));
	});

	test('browser: the widget reworks its light DOM, the island wakes, every node stays', async ({ page }) => {
		await page.goto('/dom-ownership', { waitUntil: 'load' });
		await page.waitForFunction(() => document.querySelectorAll('x-guided-e2e > .p').length === 3, null, { timeout: 8000 });
		// remember every widget child node, then wake the island
		await page.evaluate(() => {
			(window as unknown as { __kids: Element[][] }).__kids = Array.from(document.querySelectorAll('x-guided-e2e')).map((w) => Array.from(w.children));
		});
		check('island still asleep before the click', (await page.locator('ogygia-region[data-hydrated]').count()) === 0);
		await page.locator('[data-wake]').click();
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 });
		await page.locator('[data-wake]').click();
		await page.waitForTimeout(150);

		const same = await page.evaluate(() => {
			const before = (window as unknown as { __kids: Element[][] }).__kids;
			return Array.from(document.querySelectorAll('x-guided-e2e')).map((w, i) => {
				const now = Array.from(w.children);
				return { variant: w.getAttribute('data-variant'), classes: now.map((n) => n.className), identical: now.length === before[i].length && now.every((n, j) => n === before[i][j]) };
			});
		});
		for (const w of same) {
			check(`${w.variant}: backdrop, form, icon, pane all present`, w.classes.join(',') === 'p,a,b,q', w.classes.join(','));
			check(`${w.variant}: every node kept its identity`, w.identical);
		}
		check('island hydrated without recovery', (await page.locator('ogygia-region[data-og-recovered]').count()) === 0);
		check('island works after the wake', (await page.locator('[data-wake]').innerText()).includes('clicks 2'));
		check('the walked sibling of the mixed widget stays live', (await page.locator('.widget-mixed h3').innerText()).includes('(2)'));
	});
});
