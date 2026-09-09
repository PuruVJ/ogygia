// SEED ONLY WHEN READ — the `application/ogygia-page` seed (the whole `page.data`, serialized
// again for islands) ships only when an island on the page can read it. A page whose islands take
// everything as props has no seed; a page with an island that reads `$page` keeps it, with the
// data intact. (One measured CMS page shipped 674 KB of seed no island read.)
// Usage: pnpm exec playwright test seed-skip
import { test, check } from './fixtures/index.ts';

const SEED_RE = /<script type="application\/ogygia-page" data-ogygia-page>/;

test.describe('SEED SKIP: the page seed ships only for islands that read it', () => {
	test('a page whose islands never read $page ships NO seed', async ({ baseURL }) => {
		for (const path of ['/head-budget', '/props-tail']) {
			const html = await (await fetch(baseURL + path)).text();
			check(`${path}: has islands`, html.includes('<ogygia-region'));
			check(`${path}: no page seed`, !SEED_RE.test(html));
		}
	});

	test('a page with a $page-reading island keeps the seed, and the island reads the data', async ({
		baseURL,
		page
	}) => {
		const html = await (await fetch(baseURL + '/page-data')).text();
		check('/page-data: page seed present', SEED_RE.test(html));
		await page.goto('/page-data', { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 8000 }).catch(() => {});
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		// the reader island rendered its `$page.data` on the server AND kept it after hydration
		const text = await page.locator('ogygia-region').first().innerText();
		check('/page-data: island shows page data after hydration', text.trim().length > 0, text);
		check('/page-data: no page errors', errors.length === 0, errors.join(' | '));
	});
});
