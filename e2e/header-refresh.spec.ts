// THE HEADER LAB: a header rendered as a region by a remote query (`region(Header)`), HTML only, with an
// island and a hole inside. A command saves the locale the page's load reads and refreshes the query;
// the single-flight answer repaints the mounted header. The aim: nobody notices anything big —
//   • the header updates IN PLACE (the same element: a morph, not a remount);
//   • the island inside keeps its state, and reads the new locale;
//   • the hole shows its new answer and never falls back to its placeholder on the way;
//   • the header renders with its page's data (server/render-page.ts), not an empty page.
// Usage: pnpm exec playwright test header-refresh
import { expect, test } from '@playwright/test';

test('a command refreshes the header region: it morphs in place, the island keeps its state, the hole never flashes', async ({ page, context }) => {
	await context.clearCookies();
	const errors: string[] = [];
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/header-refresh');

	const header = page.locator('[data-hl-header]');
	await expect(header).toHaveAttribute('data-locale', 'en', { timeout: 10_000 });
	await expect(page.locator('[data-hl-title]')).toHaveText('Hello');
	await expect(page.locator('[data-hl-account]')).toHaveText('My account', { timeout: 10_000 });
	const counter = page.locator('[data-hl-counter]');
	await expect(counter.locator('xpath=ancestor::ogygia-region[1]')).toHaveAttribute('data-hydrated', '', { timeout: 10_000 });
	await counter.click();
	await counter.click();
	await expect(counter).toHaveText('en · 2');

	// watch the swap: the header element's identity, and any return of the hole's fallback
	await page.evaluate(() => {
		const w = window as unknown as { __hl: { header: Element | null; fallback_seen: boolean } };
		w.__hl = { header: document.querySelector('[data-hl-header]'), fallback_seen: false };
		new MutationObserver(() => {
			if (document.querySelector('[data-hl-account-fallback]')) w.__hl.fallback_seen = true;
		}).observe(document.body, { subtree: true, childList: true });
	});

	await page.locator('[data-hl-switch]').click();
	await expect(header).toHaveAttribute('data-locale', 'fr', { timeout: 10_000 });
	await expect(page.locator('[data-hl-title]')).toHaveText('Bonjour');
	await expect(page.locator('[data-hl-account]')).toHaveText('Mon compte', { timeout: 10_000 });
	await expect(counter).toHaveText('fr · 2');

	const swap = await page.evaluate(() => {
		const w = window as unknown as { __hl: { header: Element | null; fallback_seen: boolean } };
		return { same_header: w.__hl.header === document.querySelector('[data-hl-header]'), fallback_seen: w.__hl.fallback_seen };
	});
	expect(swap).toEqual({ same_header: true, fallback_seen: false });
	expect(await page.locator('[data-og-healed],[data-og-recovered]').count()).toBe(0);
	expect(errors).toEqual([]);
	await context.clearCookies();
});

// The same header on a KIT-HYDRATED page, the promise passed straight to `of` (PromiseRegion /
// PromiseRegionAwait). REGRESSION (field report on 5c0e2c45): the header never appeared — a late slot
// was registered on a Kit page, where nothing fills one; the runtime that paints a live region was
// never shipped on a csr=true page; and the islands inside rendered inline, for Kit to hydrate, inside
// HTML Kit never walks.
test('Kit-hydrated page: the header from a promise `of` is in the served page, wakes, and refreshes in place', async ({ page, context, request }) => {
	await context.clearCookies();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));

	const served = await (await request.get('/header-refresh-kit')).text();
	expect(served.includes('og-late-slot'), 'no slot nothing fills').toBe(false);
	expect(served).toContain('data-hl-header');
	expect(served).toContain('og-runtime');

	await page.goto('/header-refresh-kit');
	const header = page.locator('[data-hl-header]');
	await expect(header).toHaveAttribute('data-locale', 'en');
	expect(await page.locator('[data-hl-placeholder]').count()).toBe(0);
	const counter = page.locator('[data-hl-counter]');
	await expect(counter.locator('xpath=ancestor::ogygia-region[1]')).toHaveAttribute('data-hydrated', '', { timeout: 10_000 });
	await counter.click();
	await expect(counter).toHaveText('en · 1');
	await expect(page.locator('[data-hl-account]')).toHaveText('My account', { timeout: 10_000 });
	await page.evaluate(() => ((window as unknown as { __h: Element | null }).__h = document.querySelector('[data-hl-header]')));

	await page.locator('[data-hl-switch]').click();
	await expect(header).toHaveAttribute('data-locale', 'fr', { timeout: 10_000 });
	await expect(page.locator('[data-hl-account]')).toHaveText('Mon compte', { timeout: 10_000 });
	await expect(counter).toHaveText('fr · 1');
	expect(await page.evaluate(() => (window as unknown as { __h: Element | null }).__h === document.querySelector('[data-hl-header]'))).toBe(true);
	expect(await page.locator('[data-og-healed],[data-og-recovered]').count()).toBe(0);
	expect(errors).toEqual([]);
	await context.clearCookies();
});
