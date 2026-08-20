// A `.ts` registry, mixed: a `wake: 'visible'` binding PLACED via `<svelte:component>` (the shape
// Builder.io's SDK uses for a `customComponents` entry) AND a `region: 'raw'` binding rendered through
// `region()` + `<Region>`. Proves the mountable-`.ts`-wake change end to end: the wake binding is a real
// component (renders the island shell when placed) and stays wake-gated (hydrates only on scroll), while
// the raw held binding still renders via `region()` — both interactive, side by side, from one file.
//
// Usage: node e2e/ts-registry.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
	const errs: string[] = [];
	page.on('console', (m) => {
		if (m.type() === 'error') errs.push(m.text());
	});
	page.on('pageerror', (e) => errs.push(String(e)));
	await page.goto(base + '/ts-registry', { waitUntil: 'networkidle' });

	// ── raw held binding (region() + <Region>), wake:'load' → hydrates immediately ──
	const raw = page.locator('[data-tsraw] button').first();
	await raw.waitFor();
	check('ts-registry: raw held region SSR prop (start=3)', (await raw.textContent())!.includes('r 3'));
	await sleep(200);
	await raw.click();
	check(
		'ts-registry: raw held region (region()) hydrated + interactive',
		(await raw.textContent())!.includes('r 4'),
		(await raw.textContent())!
	);

	// ── mountable wake binding (placed via <svelte:component>), wake:'visible', below fold ──
	const widget = page.locator('[data-tsreg] button').first();
	await widget.waitFor();
	check('ts-registry: wake widget SSR prop (start=7)', (await widget.textContent())!.includes('n 7'));

	// wake:'visible' + below the fold → the WIDGET is not hydrated until scrolled into view (the raw
	// wake:'load' island above may already be hydrated, so scope the check to the widget's shell).
	const widgetHydratedBefore = await page.locator('ogygia-region[data-hydrated] [data-tsreg]').count();
	check('ts-registry: wake widget not hydrated before scroll (wake:visible gates)', widgetHydratedBefore === 0, `hydrated=${widgetHydratedBefore}`);

	await widget.scrollIntoViewIfNeeded();
	await sleep(300);
	await widget.click();
	await widget.click();
	check(
		'ts-registry: mountable .ts wake binding (svelte:component) hydrated + interactive',
		(await widget.textContent())!.includes('n 9'),
		(await widget.textContent())!
	);

	// ── asRegion() of a NAMED barrel import, in the .ts file, placed via <svelte:component> ──
	const asr = page.locator('[data-ticker] button').first();
	await asr.waitFor();
	check('ts-registry: asRegion(named barrel) SSR prop (start=10)', (await asr.textContent())!.includes('ticks 10'));
	await asr.scrollIntoViewIfNeeded();
	await sleep(300);
	await asr.click();
	check(
		'ts-registry: asRegion(named barrel) in a .ts file hydrated + interactive',
		(await asr.textContent())!.includes('ticks 11'),
		(await asr.textContent())!
	);

	check('ts-registry: no console errors', errs.length === 0, errs.join(' | '));
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL ts-registry CHECKS PASSED' : failures + ' ts-registry CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
