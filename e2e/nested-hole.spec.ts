// Nested islands inside a DEFERRED hole, carried into snippets via RELATIVE specifiers. The build
// half of this regression is the playground build itself (it used to die with an UNRESOLVED_IMPORT
// out of a region module — see lib/holes/NestedHole.svelte); this half proves the far side: once the
// hole's HTML lands, every island the snippets carried is live (its click counts), not frozen HTML.
//
// Usage: pnpm exec playwright test nested-hole
import { test, check, expect } from './fixtures/index.ts';

test.describe('deferred hole → snippets → nested islands via relative imports: build resolves + they hydrate', () => {
	test('every carried island is interactive after the hole lands', async ({ page }) => {
		const errs: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'error') errs.push(m.text());
		});
		page.on('pageerror', (e) => errs.push(String(e)));

		await page.goto('/nested-hole', { waitUntil: 'networkidle' });
		// the hole is `render: 'deferred', wake: 'load'` — its HTML swaps in after the shell
		await page.locator('[data-nested-hole]').waitFor();
		check(
			'hole rendered on the far side (fallback gone)',
			(await page.locator('[data-nested-hole-fallback]').count()) === 0
		);

		const click_counts = async (scope: string, sel: string, n_sel: string, expected: string) => {
			const btn = page.locator(`${scope} ${sel}`).first();
			await btn.waitFor();
			await btn.click();
			await expect(page.locator(`${scope} ${n_sel}`).first()).toHaveText('1');
			check(`${expected} is live (click counted)`, true);
		};

		// 1. control — direct placement
		await click_counts('[data-nested-direct]', '[data-nested-inner]', '[data-nested-inner-n]', 'direct');
		// 2. `../` island in a 0-arg snippet at a plain site (the reported shape)
		await click_counts('[data-nested-in-snippet]', '[data-nested-inner]', '[data-nested-inner-n]', 'snippet ../');
		// 3. `./` sibling island in the same snippet
		await click_counts('[data-nested-in-snippet]', '[data-nested-sibling]', '[data-nested-sibling-n]', 'snippet ./');
		// 6. plain relative helper captured into the snippet (resolve_id's rebase — the control)
		await expect(page.locator('[data-nested-helper]')).toHaveText('HELPER');
		// 4. parameterized snippet at an island site — both rows carry a live island
		await click_counts('[data-nested-row="1"]', '[data-nested-inner]', '[data-nested-inner-n]', 'island-site row 1');
		await click_counts('[data-nested-row="2"]', '[data-nested-inner]', '[data-nested-inner-n]', 'island-site row 2');
		// 5. snippet nested in a snippet
		await click_counts('[data-nested-deep]', '[data-nested-inner]', '[data-nested-inner-n]', 'nested snippet');

		check('no console / page errors', errs.length === 0, errs.join('\n'));
	});
});
