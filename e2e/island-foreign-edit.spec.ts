// AN ISLAND HYDRATES AGAINST ITS OWN SERVER MARKUP. The page's inline script strips every
// whitespace text node inside each sleeping island after load and leaves a stray comment — what a
// customer's design-system runtime did to a whole header while the islands in it slept. Before:
// Svelte's walk mismatched on wake, the server DOM was discarded and re-rendered client-side, and
// the click that woke the interaction island was replayed onto a dead node (two clicks to open a
// login dropdown). Now the runtime puts the server markup back and hydrates that: one click
// counts, the visible island wakes clean, no recovery warning.
//
//   pnpm exec playwright test island-foreign-edit
import { test, check, sleep } from './fixtures/index.ts';

const DISCARDED_RE = /discarded its ENTIRE server-rendered DOM/;
const FAILED_TO_HYDRATE_RE = /Failed to hydrate/;

test('edited-while-asleep islands: first click counts, scroll wakes clean, nothing re-rendered', async ({ page }) => {
	const errs: string[] = [];
	const warns: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errs.push('console: ' + m.text());
		if (m.type() === 'warning') warns.push(m.text());
	});
	await page.goto('/island-foreign-edit/', { waitUntil: 'networkidle' });
	await sleep(400);
	const tap = page.locator('[data-interaction-island] ogygia-region');
	const scroll = page.locator('[data-visible-island] ogygia-region');
	check('the foreign edit happened (whitespace nodes removed from the sleeping islands)', Number(await tap.getAttribute('data-foreign-edited')) > 0 && Number(await scroll.getAttribute('data-foreign-edited')) > 0);
	check('interaction island still asleep', (await tap.getAttribute('data-hydrated')) === null);

	const btn = page.locator('[data-interaction-island] [data-spaced-counter] button');
	await btn.click();
	await page.waitForSelector('[data-interaction-island] ogygia-region[data-hydrated]', { timeout: 10_000 });
	await sleep(300);
	check('ONE click: woke AND counted (3 → 4)', (await btn.textContent())!.includes('count is 4'), await btn.textContent());
	check('interaction island hydrated from its server markup (data-og-healed)', (await tap.getAttribute('data-og-healed')) !== null);
	check('not Svelte’s client re-render (no data-og-recovered)', (await tap.getAttribute('data-og-recovered')) === null);
	await btn.click();
	check('still interactive (4 → 5)', (await btn.textContent())!.includes('count is 5'));

	await page.locator('[data-visible-island]').scrollIntoViewIfNeeded();
	await page.waitForSelector('[data-visible-island] ogygia-region[data-hydrated]', { timeout: 10_000 });
	const vbtn = page.locator('[data-visible-island] [data-spaced-counter] button');
	check('visible island kept its SSR count (7)', (await vbtn.textContent())!.includes('count is 7'));
	check('visible island healed too', (await scroll.getAttribute('data-og-healed')) !== null);
	await vbtn.click();
	check('visible island interactive (7 → 8)', (await vbtn.textContent())!.includes('count is 8'));

	check('no recovery warning', !warns.some((w) => DISCARDED_RE.test(w)), warns.filter((w) => DISCARDED_RE.test(w)).join('; '));
	check('no "Failed to hydrate"', !warns.some((w) => FAILED_TO_HYDRATE_RE.test(w)));
	check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
});
