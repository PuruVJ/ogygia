// Server-delta nav: a layout island shared by two routes (DeltaNav, identical fingerprint on both)
// is NOT re-rendered by the server on an SPA nav between them — proven by `data-og-skipped` in the
// delta response and by the client keeping it live + interactive (no blank hole).
//
// Run: pnpm exec playwright test server-delta
import { test, check } from './fixtures/index.ts';

test.describe('server-delta nav: shared island skipped server-side on SPA nav, kept live + interactive (no blank hole)', () => {
	test('the server skips a known shared island on the delta render; the client keeps it live across A→B', async ({
		page,
		context,
		baseURL
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(String(e)));

		// ── SSR + hydrate on route A ─────────────────────────────────────────────────
		await page.goto('/delta/a', { waitUntil: 'networkidle' });
		await page.waitForTimeout(400);
		check(
			'SSR: shared nav island present on A',
			(await page.locator('[data-delta-nav]').count()) === 1
		);
		const known = await page.evaluate(() =>
			[...document.querySelectorAll('ogygia-region[data-og-fp][data-hydrated]')]
				.map((e) => e.getAttribute('data-og-fp'))
				.join(',')
		);
		check('A: nav island is hydrated (has a data-og-fp)', known.length > 0);

		// ── the server SKIPS the shared island when told the client has it ───────────
		const full = await (
			await context.request.get(baseURL + '/delta/b', { headers: { 'x-ogygia-spa': '1' } })
		).text();
		const delta = await (
			await context.request.get(baseURL + '/delta/b', {
				headers: { 'x-ogygia-spa': '1', 'x-ogygia-known': known }
			})
		).text();
		check('full render (no known) does NOT skip the nav island', !full.includes('data-og-skipped'));
		check(
			'delta render (with known) SKIPS the shared nav island (server did not re-render it)',
			delta.includes('data-og-skipped'),
			`deltaLen=${delta.length} fullLen=${full.length}`
		);
		check(
			'delta is smaller than the full render (compute + bytes saved)',
			delta.length < full.length
		);

		// ── SPA-nav A→B: the shared island stays LIVE + interactive, no blank hole ────
		await page.locator('[data-delta-btn]').click();
		await page.locator('[data-delta-btn]').click();
		await page.waitForTimeout(60);
		check(
			'nav island interactive on A (clicks → 2)',
			(await page.locator('[data-delta-clicks]').innerText()) === '2'
		);
		const stampA = (await page.locator('[data-delta-stamp]').innerText()).trim();

		await page.locator('[data-to-b]').click();
		await page.waitForTimeout(500);
		check('navigated to B', (await page.locator('[data-delta-page]').innerText()) === 'Delta B');
		check(
			'shared nav island SURVIVED the nav (not a blank hole)',
			(await page.locator('[data-delta-nav]').count()) === 1
		);
		const stampB = (await page.locator('[data-delta-stamp]').innerText()).trim();
		check(
			'nav island is the SAME live node (server-stamp unchanged = kept, not re-rendered)',
			stampA === stampB,
			`${stampA} vs ${stampB}`
		);
		await page.locator('[data-delta-btn]').click();
		await page.waitForTimeout(50);
		check(
			'nav island STILL interactive after nav + click state survived (clicks → 3)',
			(await page.locator('[data-delta-clicks]').innerText()) === '3'
		);
		check(
			'no page errors across the whole flow',
			errors.length === 0,
			errors.slice(0, 2).join(' | ')
		);
	});
});
