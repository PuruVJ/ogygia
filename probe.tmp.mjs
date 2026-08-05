import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('response', async (r) => {
	const u = decodeURIComponent(r.url());
	if (u.includes('🏝️')) console.log('[response]', r.status(), (await r.text()).slice(0, 90));
});
await page.goto(base + '/lakes', { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 1200));

const swr = page.locator('[data-swr-demo]');
await swr.locator('[data-toggle-btn]').click();
await new Promise((r) => setTimeout(r, 250));
await swr.locator('[data-toggle-btn]').click();
await new Promise((r) => setTimeout(r, 900));

console.log(
	'regions:',
	JSON.stringify(
		await page.evaluate(() =>
			[...document.querySelectorAll('ogygia-region[hydrate="none"]')].map((el) => ({
				entry: el.getAttribute('entry'),
				remount: el.getAttribute('remount'),
				revalidated: el.hasAttribute('data-revalidated'),
				boxes: el.querySelectorAll('[data-frozen-box]').length,
				inner: el.querySelectorAll('[data-inner-btn]').length
			}))
		),
		null,
		1
	)
);

// inner island inside the SWR-refreshed lake must still self-hydrate
const innerBtn = swr.locator('[data-inner-btn]').first();
const a = (await innerBtn.textContent()).trim();
await innerBtn.click();
const b = (await innerBtn.textContent()).trim();
console.log('inner island after swr fetch:', a, '->', b);

await browser.close();
