// The SERVER ROUTER's document seeds like a Kit page: the page seed ships only when an island on the
// page reads it, and only the keys it reads. (It used to ship `page.data` whole on every router
// page: the profiler's report page carried its whole 2.9 MB report, read by nobody.)
import { test, expect } from '@playwright/test';

const seed_of = (html: string) => html.match(/<script type="application\/ogygia-page"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? null;

test.describe('server router page seed', () => {
	test('an island that reads page.data gets it, shaped to the key it reads', async ({ page, request }) => {
		const html = await (await request.get('/rtr/reader')).text();
		const seed = seed_of(html);
		expect(seed, 'the reader island needs the seed').not.toBeNull();
		expect(seed).toContain('"who":"ada"');
		// `big` is in page.data (the load returned it) but no island reads it
		expect(seed!.length).toBeLessThan(10_000);
		await page.goto('/rtr/reader');
		await expect(page.locator('[data-rtr-who]')).toHaveText('ada');
	});

	test('a router page whose islands read nothing ships no seed', async ({ request }) => {
		const html = await (await request.get('/rtr/')).text();
		expect(html).toContain('router home page');
		expect(seed_of(html)).toBeNull();
	});
});
