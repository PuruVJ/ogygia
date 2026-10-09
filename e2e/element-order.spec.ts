// THE ELEMENT ORDERS ITS CHILDREN (runtime/ownership.ts facets, internal/notes/dom-ownership.md §11):
// a hole's answer morphed into a custom element that re-appended its element children at upgrade.
//
// REGRESSION (field report on 6b927c3c): the fallback's empty panel was kept beside the answer's full
// one, and painted over it — a blank mega-menu panel for one group of users.
// Usage: pnpm exec playwright test element-order
import { expect, test } from '@playwright/test';

test('the answer’s full panel replaces the fallback’s empty one: one panel, all rows', async ({ page }) => {
	await page.goto('/element-order');
	await expect(page.locator('#eo-row-3')).toBeAttached({ timeout: 10_000 });
	await page.waitForTimeout(200);
	expect(await page.locator('eo-shell [data-eo-panel]').count()).toBe(1);
	expect(await page.locator('eo-shell [id^="eo-row-"]').count()).toBe(3);
});
