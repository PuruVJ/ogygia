// Cross-island context (`createContext()` + `<Context of value>`) exercised against every other
// area of the library: hydration strategies (load/idle/visible/defer), nested islands, lakes,
// nested providers (shadowing), plain values + defaults, transportable-prop coexistence, and SPA
// navigation. A live [ogygia.wire] value reunites into ONE instance across roots; a plain value is
// a per-consumer snapshot; a missing provider yields the default.
// Usage: node verify/context.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!cond) failures++;
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});

	// ---------- SSR of the matrix page ----------
	const raw = await (await fetch(base + '/context')).text();
	check('SSR: provider emits <ogygia-context> with tag', /<ogygia-context[^>]*\bctx=/.test(raw));
	check('SSR: context value serialized into the DOM', raw.includes('data-ogygia-ctx'));
	const ssrLoad = raw.match(/data-ctx-reader="load"[^>]*>[\s\S]*?data-ctx-count[^>]*>(-?\d+)</)?.[1];
	check('SSR: load reader reads context (5, no prop)', ssrLoad === '5', `count=${ssrLoad}`);

	// ---------- Hydrated matrix ----------
	await page.goto(base + '/context', { waitUntil: 'networkidle' });
	await page.waitForTimeout(250);

	const count = (label: string) =>
		page.locator(`[data-ctx-reader="${label}"] [data-ctx-count]`).innerText();
	const isInstance = (label: string) =>
		page.locator(`[data-ctx-reader="${label}"]`).getAttribute('data-is-instance');

	// Strategies all decoded a real instance from context (no prop)
	check('load reader: real instance', (await isInstance('load')) === 'true');
	check('idle reader: real instance', (await isInstance('idle')) === 'true');
	check('load reader count == SSR (no reset)', (await count('load')) === '5', `count=${await count('load')}`);

	// Nested-island inner reader (degraded + hydrated with outer) reads context
	check('nested-island reader reads context', (await count('nested-inner')) === '5', `count=${await count('nested-inner')}`);

	// Coexist: same counter via prop AND via context → identical live instance
	check('coexist: prop and context are the SAME instance', (await page.locator('[data-ctx-coexist]').getAttribute('data-same')) === 'true');
	check('coexist: context count matches', (await page.locator('[data-ctx-coexist] [data-coexist-ctx]').innerText()) === '5');

	// Nested provider shadowing: inner sees 99, outer sees 5
	check('shadow: inner provider wins (99)', (await count('inner-scope')) === '99', `count=${await count('inner-scope')}`);
	check('shadow: outer scope unaffected (5)', (await count('outer-scope')) === '5', `count=${await count('outer-scope')}`);

	// Plain value + default + orphan
	check('plain value: provided theme = dark', (await page.locator('[data-ctx-theme="provided"]').innerText()) === 'dark');
	check('plain value: default theme = light', (await page.locator('[data-ctx-theme="defaulted"]').innerText()) === 'light');
	check('orphan context: default returned', (await page.locator('[data-ctx-orphan]').innerText()) === 'orphan-default');

	// ---------- Liveness: one write repaints every live reader ----------
	await page.locator('[data-ctx-writer] button').click();
	await page.waitForTimeout(80);
	check('write repaints load reader', (await count('load')) === '6', `count=${await count('load')}`);
	check('write repaints idle reader (shared)', (await count('idle')) === '6', `count=${await count('idle')}`);
	check('write repaints nested-island reader', (await count('nested-inner')) === '6', `count=${await count('nested-inner')}`);
	check('write repaints coexist (prop path too)', (await page.locator('[data-ctx-coexist] [data-coexist-prop]').innerText()) === '6');
	check('shadow inner unaffected by outer write (99)', (await count('inner-scope')) === '99');

	// Deferred CLIENT island (defer+hydrate): fetched from the endpoint, then hydrated on the client,
	// where the DOM walk joins the live instance.
	await page.waitForTimeout(250);
	check('defer+hydrate island joins live instance', (await isInstance('defer-hydrate')) === 'true' && (await count('defer-hydrate')) === '6', `count=${await count('defer-hydrate')}`);

	// Pure SERVER island (defer only): rendered in isolation on the endpoint with no page provider,
	// and never client-hydrated — so it can only ever see the context default. This is the documented
	// server-island isolation boundary, not a bug.
	check('server island sees only the default (isolated render)', (await count('server')) === '-1' && (await isInstance('server')) === 'false', `count=${await count('server')}`);

	// Visible reader: below the fold, still SSR (5) until scrolled; scrolling hydrates it and it
	// LATE-JOINS the already-mutated instance (6), proving late hydration reunites.
	check('visible reader still SSR before scroll (5)', (await count('visible')) === '5', `count=${await count('visible')}`);
	await page.locator('[data-ctx-reader="visible"]').scrollIntoViewIfNeeded();
	await page.waitForTimeout(150);
	check('visible reader late-joins live instance (6)', (await count('visible')) === '6', `count=${await count('visible')}`);

	// ---------- Island inside a frozen lake reads the page provider ----------
	{
		const lakeRaw = await (await fetch(base + '/context/lake')).text();
		const ssrLake = lakeRaw.match(/data-ctx-reader="in-lake"[^>]*>[\s\S]*?data-ctx-count[^>]*>(-?\d+)</)?.[1];
		check('lake SSR: island-in-lake reads context (7)', ssrLake === '7', `count=${ssrLake}`);
		const lp = await browser.newPage();
		const lerrs: string[] = [];
		lp.on('pageerror', (e) => lerrs.push(e.message));
		await lp.goto(base + '/context/lake', { waitUntil: 'networkidle' });
		await lp.waitForTimeout(200);
		const lakeCount = await lp.locator('[data-ctx-reader="in-lake"] [data-ctx-count]').innerText();
		check('lake: self-hydrated island-in-lake reads context (7)', lakeCount === '7', `count=${lakeCount}`);
		check('lake: no page errors', lerrs.length === 0, lerrs.join(' | '));
		await lp.close();
	}

	// ---------- Context after SPA navigation ----------
	{
		const nav = await browser.newPage();
		const nerrs: string[] = [];
		nav.on('pageerror', (e) => nerrs.push(e.message));
		await nav.goto(base + '/nested', { waitUntil: 'networkidle' });
		await nav.locator('[data-ctx-nav-link]').click();
		await nav.waitForTimeout(250);
		const navCount = () => nav.locator('[data-ctx-reader="nav"] [data-ctx-count]').innerText();
		check('SPA nav: reader reads context on new page (3)', (await navCount()) === '3', `count=${await navCount()}`);
		// Regression: the destination page's CSS must survive island `<svelte:head>` hydration. Clean
		// in-place hydration runs that head reconciliation, which removes a TRAILING head-node range —
		// so the router inserts SPA stylesheets at the TOP of <head>. Before the fix, this page's
		// `:global(ogygia-region){display:block}` was reclaimed, collapsing the layout until the reader
		// island overlapped the writer button (making it unclickable).
		const navRegionDisplay = await nav.evaluate(
			() => getComputedStyle(document.querySelector('ogygia-region')!).display
		);
		check('SPA nav: destination page CSS survives hydration (region display:block)', navRegionDisplay === 'block', navRegionDisplay);
		await nav.locator('[data-ctx-writer] button').click();
		await nav.waitForTimeout(80);
		check('SPA nav: live update works after nav (4)', (await navCount()) === '4', `count=${await navCount()}`);
		check('SPA nav: no page errors', nerrs.length === 0, nerrs.join(' | '));
		await nav.close();
	}

	check('matrix: no page errors / hydration mismatches', errors.length === 0, errors.join(' | '));
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL CONTEXT CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
