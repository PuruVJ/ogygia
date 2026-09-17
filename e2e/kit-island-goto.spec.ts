// `goto()` FROM AN ISLAND, on both kinds of document. Inside an island, `$app/navigation` is the
// ogygia shim. On a csr=false page it drives the ogygia router (a body swap). On a csr=true page
// Kit owns the document: the shim must hand the call to Kit's real `goto` (published by the
// kit-page thread), because the ogygia router does not own that page and could only fall back to a
// full load. A customer's green-band chips — `goto()` calls inside a live island on the account
// page — reloaded the whole page on every click while Kit-hydrated cards navigated client-side.
//
//   pnpm exec playwright test kit-island-goto
import { test, check } from './fixtures/index.ts';

async function click_probe(page: import('@playwright/test').Page, path: string) {
	await page.goto(path, { waitUntil: 'networkidle' });
	await page.waitForSelector('[data-goto-probe]', { timeout: 10_000 });
	await page.evaluate(() => {
		(window as unknown as { __og_marker: number }).__og_marker = 1;
	});
	await page.locator('[data-goto-probe]').click();
	await page.waitForFunction(() => location.search === '?probe=1', null, { timeout: 10_000 }).catch(() => {});
	const marker = await page.evaluate(() => (window as unknown as { __og_marker?: number }).__og_marker);
	return { url: page.url(), client_side: marker === 1 };
}

test('csr=true page: an island’s goto() goes through Kit’s router (no reload)', async ({ page }) => {
	const r = await click_probe(page, '/kit');
	check('navigated to ?probe=1', r.url.endsWith('/kit?probe=1'), r.url);
	check('client-side: the page was NOT reloaded', r.client_side);
	// Kit's own page state moved with it: the island reads it through the thread
	check('the island sees Kit’s new page.url', (await page.locator('[data-goto-probe-search]').textContent()) === '?probe=1');
});

test('csr=false page: an island’s goto() goes through the ogygia router (no reload)', async ({ page }) => {
	const r = await click_probe(page, '/shared-page-module');
	check('navigated to ?probe=1', r.url.endsWith('/shared-page-module?probe=1'), r.url);
	check('client-side: the page was NOT reloaded', r.client_side);
});
