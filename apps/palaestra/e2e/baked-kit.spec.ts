// A BAKED held region on a Kit-hydrated (csr=true) page: a remote query's region awaited in the render,
// its first HTML baked into the page. Its inside is OPAQUE to Kit (region-attrs.ts `OPAQUE_SELECTOR`):
// - the region element is adopted as it stands — as an `{@html}`, Svelte's hydration walked to the
//   render's own top-level block marker, threw `hydration_mismatch`, and Kit remounted the page with
//   the region emptied;
// - every island in it wakes on the runtime — they were handed to Kit (`data-kit-hydrated`), which
//   never sees them, and stayed inert (a field header's survey island, an `idle` one shown only to
//   signed-in visitors, among them);
// - the hole in it lands.
// Usage: pnpm exec playwright test baked-kit
import { test, check, expect } from '@ogygia/tooling/e2e';

test('a baked region on a Kit-hydrated page hydrates cleanly, and every island in it wakes on the runtime', async ({
	page,
	baseURL
}) => {
	const raw = await (await fetch(baseURL + '/baked-kit')).text();
	check(
		'SSR: the region is baked into the page',
		raw.includes('data-og-baked') && raw.includes('data-bk-title')
	);
	check(
		'SSR: the signed-in visitor’s idle island is in it',
		raw.includes('data-bk-counter="idle"')
	);

	const problems: string[] = [];
	page.on('pageerror', (e) => problems.push(e.message));
	page.on('console', (m) => {
		const t = m.text();
		if (m.type() === 'error' || t.includes('hydration_mismatch')) problems.push(t.slice(0, 200));
	});
	await page.goto('/baked-kit', { waitUntil: 'networkidle' });

	check(
		'the region kept its content through Kit’s hydration',
		(await page.locator('ogygia-region[data-og-baked] [data-bk-title]').count()) === 1
	);
	for (const name of ['load', 'idle']) {
		const button = page.locator(`[data-bk-counter="${name}"]`);
		const region = button.locator('xpath=ancestor::ogygia-region[1]');
		await expect(region, `${name} island woke`).toHaveAttribute('data-hydrated', '', {
			timeout: 10_000
		});
		check(
			`${name} island was not handed to Kit`,
			!(await region.getAttribute('data-kit-hydrated'))
		);
		await button.click();
		await expect(button.locator('[data-bk-n]'), `${name} island counts`).toHaveText('1');
	}
	await expect(page.locator('[data-bk-hole]'), 'the hole landed').toHaveCount(1, {
		timeout: 10_000
	});
	check(
		'the hole’s fallback is gone',
		(await page.locator('[data-bk-hole-fallback]').count()) === 0
	);
	check('no hydration mismatch or page error', problems.length === 0, problems.join(' | '));
});
