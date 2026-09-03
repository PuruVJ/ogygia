// og.$ — a function crosses the island boundary as a fn ref and rebinds on the client.
// The csr=false host marks a closure (local `tax` capture) into context; the island reads
// `getContext('fmt')` and calls it. Verifies: SSR render, hydration without errors, the
// bound result (x119.00), i.e. hoist → handle → payload(source fallback)/manifest → rebind.
//
// STANDALONE (not yet in e2e/run.ts — register it there as: ['dollar-fn.ts', true, 'og.$ fn
// ref crosses context into an island and rebinds']). Usage: pnpm exec playwright test dollar-fn
import { test, check } from './fixtures/index.ts';

test.describe('og.$: a fn ref crosses context into an island and rebinds (bound captures)', () => {
	test('fmt(100) with the bound capture (tax=0.19) → x119.00', async ({ page }) => {
		const errors: string[] = [];
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push(m.text());
		});
		page.on('pageerror', (e) => errors.push(String(e)));

		await page.goto('/dollar-fn', { waitUntil: 'networkidle' });
		check('SSR: island button rendered', (await page.locator('[data-dollar-btn]').count()) === 1);
		check(
			'SSR: output empty before click',
			(await page.locator('[data-dollar-out]').innerText()).trim() === ''
		);

		await page.locator('[data-dollar-btn]').click();
		await page.waitForTimeout(150);
		const out = (await page.locator('[data-dollar-out]').innerText()).trim();
		check('island: fmt(100) with the bound capture (tax=0.19)', out === 'x119.00', `out=${out}`);
		check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
	});
});
