// A `visible` ISLAND'S CODE WAITS FOR THE VIEWPORT. Under the default preload policy (`'load'`)
// the options doc promises that visible islands fetch their code when they intersect and that
// nothing downloads before there is a reason to. The runtime broke that with an idle-time
// `import()` of every visible island's module one second after load — a customer home page pulled
// 1.1 MB of below-the-fold island code for visitors who never scrolled. Now: no request for the
// island's entry until it scrolls into view; then it fetches, hydrates, and works.
//
//   pnpm exec playwright test visible-below
import { test, check, sleep } from './fixtures/index.ts';

test('a visible island 4000px down fetches nothing until scrolled into view', async ({ page }) => {
	const entries: string[] = [];
	page.on('request', (r) => { if (/og-region\.[a-f0-9]+\.js/.test(r.url())) entries.push(r.url().replace(/^.*\//, '')); });
	await page.goto('/visible-below/', { waitUntil: 'networkidle' });
	const entry = (await page.locator('[data-below] ogygia-region').getAttribute('entry'))!.replace(/^.*\//, '');
	await sleep(3000); // well past any idle callback
	check('island not hydrated before scroll', (await page.locator('[data-below] ogygia-region[data-hydrated]').count()) === 0);
	check('island entry NOT requested before scroll', !entries.includes(entry), entries.join(', '));
	await page.locator('[data-below]').scrollIntoViewIfNeeded();
	await page.waitForSelector('[data-below] ogygia-region[data-hydrated]', { timeout: 10_000 });
	check('island entry requested after scroll', entries.includes(entry));
	const btn = page.locator('[data-below] [data-counter] button');
	check('SSR count kept', (await btn.textContent())!.includes('count is 3'));
	await btn.click();
	check('island interactive after its late fetch', (await btn.textContent())!.includes('count is 4'));
});
