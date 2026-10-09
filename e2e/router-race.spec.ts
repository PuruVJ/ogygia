// P2: overlapping SPA navigations must not leave URL ≠ DOM (last-nav-wins).
// Usage: pnpm exec playwright test router-race
import { test, check } from './fixtures/index.ts';

const FORMS_HEADING_RE = /classic form actions/i;

test.describe('overlapping SPA navigations / stale-swap guards', () => {
	test('last navigation wins: URL settles on /data and the DOM matches it', async ({ page }) => {
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('meta[name="ogygia-router"]', { state: 'attached' });

		// /forms is heavier; /data is light — classic last-fetch-wins repro from the audit.
		await page.evaluate(() => {
			(document.querySelector('a[href="/forms"]') as HTMLAnchorElement | null)?.click();
		});
		await page.waitForTimeout(40);
		await page.evaluate(() => {
			(document.querySelector('a[href="/data"]') as HTMLAnchorElement | null)?.click();
		});

		await page.waitForURL('**/data', { timeout: 8000 }).catch(() => {});
		await page.waitForTimeout(800);

		const path = await page.evaluate(() => location.pathname);
		const h1 = (
			(await page
				.locator('h1')
				.first()
				.textContent()
				.catch(() => '')) || ''
		).trim();

		check('URL settled on last navigation (/data)', path === '/data', path);
		check(
			'DOM matches URL (not forms Guestbook heading)',
			path === '/data' && !FORMS_HEADING_RE.test(h1),
			`path=${path} h1=${h1}`
		);
	});
});
