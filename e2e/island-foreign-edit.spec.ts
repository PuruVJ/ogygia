// AN ISLAND HYDRATES AGAINST ITS OWN SERVER MARKUP. The page's foreign tool strips every
// whitespace text node inside each sleeping island and leaves a stray comment — what a customer's
// design-system runtime did to a whole header while the islands in it slept. Before: Svelte's walk
// mismatched on wake, the server DOM was discarded and re-rendered client-side, and the click that
// woke the interaction island was replayed onto a dead node (two clicks to open a login dropdown).
// Now the runtime puts the server markup back and hydrates that: one click counts, the visible
// island wakes clean, no recovery warning.
//
// The tool is a MODULE script in the page's head, ahead of Kit's head slot — where an app template
// loads a design-system runtime. Module scripts run in document order, so the server copy is only
// the server's if the ogygia runtime runs FIRST: the handle moves its bootstrap to the front of
// `<head>`. This spec fails without that (the tool strips before the runtime looks, and the copy
// is the edited DOM — what a customer deploy measured).
//
//   pnpm exec playwright test island-foreign-edit
import { test, check, sleep } from './fixtures/index.ts';

const DISCARDED_RE = /discarded its ENTIRE server-rendered DOM/;
const FAILED_TO_HYDRATE_RE = /Failed to hydrate/;
const HEAD_RE = /<head\b[^>]*>([\s\S]*?)<\/head>/i;
const SCRIPT_TAG_RE = /<script\b[^>]*>/gi;
const RUNTIME_RE = /data-ogygia-runtime/;

test('edited-while-asleep islands: first click counts, scroll wakes clean, nothing re-rendered', async ({ page }) => {
	const errs: string[] = [];
	const warns: string[] = [];
	page.on('pageerror', (e) => errs.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errs.push('console: ' + m.text());
		if (m.type() === 'warning') warns.push(m.text());
	});
	const res = await page.goto('/island-foreign-edit/', { waitUntil: 'networkidle' });
	const head = HEAD_RE.exec((await res!.text()) ?? '')?.[1] ?? '';
	const scripts = head.match(SCRIPT_TAG_RE) ?? [];
	check('the runtime bootstrap is the FIRST script in <head> (the foreign tool comes after it)', scripts.length >= 2 && RUNTIME_RE.test(scripts[0]) && !RUNTIME_RE.test(scripts[1]), scripts.slice(0, 2).join(' '));
	await sleep(400);
	const tap = page.locator('[data-interaction-island] ogygia-region');
	const scroll = page.locator('[data-visible-island] ogygia-region');
	check('the foreign edit happened (whitespace nodes removed from the sleeping islands)', Number(await tap.getAttribute('data-foreign-edited')) > 0 && Number(await scroll.getAttribute('data-foreign-edited')) > 0);
	check('the tool ran AFTER the runtime defined <ogygia-region> (the server copy predates the edit)', (await tap.getAttribute('data-foreign-before-runtime')) === 'false', await tap.getAttribute('data-foreign-before-runtime'));
	check('interaction island still asleep', (await tap.getAttribute('data-hydrated')) === null);

	const btn = page.locator('[data-interaction-island] [data-spaced-counter] button');
	await btn.click();
	await page.waitForSelector('[data-interaction-island] ogygia-region[data-hydrated]', { timeout: 10_000 });
	await sleep(300);
	check('ONE click: woke AND counted (3 → 4)', (await btn.textContent())!.includes('count is 4'), await btn.textContent());
	check('interaction island hydrated from its server markup (data-og-healed)', (await tap.getAttribute('data-og-healed')) !== null);
	check('not Svelte’s client re-render (no data-og-recovered)', (await tap.getAttribute('data-og-recovered')) === null);
	// The repair goes through the morph: the foreign element inside kept its identity, so its connect
	// reaction did NOT run again (a re-created node would strip the island a second time).
	check('the foreign element connected exactly once (kept by the repair, not re-created)', (await tap.getAttribute('data-foreign-connects')) === '1', await tap.getAttribute('data-foreign-connects'));
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
