// ISLAND FILES ON A KIT-HYDRATED PAGE BELOW THE ROOT (kit-paths.ts). Kit 2's browser `asset()` never
// refuses a path without its leading slash — it returns `base + file` — so ogygia's old probe (try
// slash-less, fall back on a refusal) answered "no slash" in the browser and built `_app/immutable/…`,
// which a page at `/lake-kit/kit/` resolved to `/lake-kit/kit/_app/immutable/…` and 404'd. The
// server's `asset()` does refuse, which is why only a csr=true page (where Region renders in the
// browser) ever showed it. The plugin now defines the app's Kit major at build time.
//
// REGRESSION (field report on 5c0e2c45): `Not found: /myschneider/_uce_/immutable/og-region.*.js`.
// Usage: pnpm exec playwright test kit-nested-assets
import { expect, test } from '@playwright/test';

test('a csr=true page below the root requests every ogygia file from the root, and none 404s', async ({ page, baseURL }) => {
	const misses: string[] = [];
	const ours: string[] = [];
	page.on('response', (r) => {
		const u = new URL(r.url());
		if (!u.pathname.includes('/og-region.') && !u.pathname.includes('/og-runtime')) return;
		ours.push(u.pathname);
		if (r.status() >= 400) misses.push(`${r.status()} ${u.pathname}`);
	});
	await page.goto('/lake-kit/kit/', { waitUntil: 'networkidle' });
	// Kit hydrated the page, and the lake's island woke
	await page.locator('[data-kit-btn]').click();
	await expect(page.locator('[data-kit-btn]')).toHaveText('kit:1');
	await expect(page.locator('ogygia-region[data-hydrated]').first()).toBeAttached({ timeout: 10_000 });
	await page.waitForTimeout(500);

	expect(misses, 'no ogygia file 404s').toEqual([]);
	expect(ours.length, 'the page loaded ogygia files at all').toBeGreaterThan(0);
	expect(ours.filter((p) => p.startsWith('/lake-kit/')), 'none resolved against the page path').toEqual([]);
	// and every island entry attribute the browser wrote is root-absolute
	const relative = await page.evaluate(() =>
		[...document.querySelectorAll('ogygia-region[entry], ogygia-region[src]')]
			.flatMap((e) => [e.getAttribute('entry'), e.getAttribute('src')])
			.filter((v): v is string => !!v && v.includes('og-region') && !v.startsWith('/') && !v.startsWith('.') && !v.includes('://'))
	);
	expect(relative, 'no page-relative entry').toEqual([]);
	void baseURL;
});
