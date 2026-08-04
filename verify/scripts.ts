// Playwright checks for authored scripts inside islands pages:
// inline (first-load only), data-rerun (re-runs on SPA arrival), bundled <script island>.
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out = [];
function check(name, cond, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const get = (page, k) => page.evaluate((n) => window[n], k);

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	const errs = [];
	page.on('pageerror', (e) => errs.push(e.message));

	// full load of settings
	await page.goto(base + '/dashboard/settings', { waitUntil: 'load' });
	await page.waitForTimeout(300);
	check('inline script ran on first load', (await get(page, '__settingsInline')) === 1);
	check('data-rerun script ran on first load', (await get(page, '__rerunCount')) === 1);
	check('bundled <script island> ran on first load', (await get(page, '__bundledRan')) === 1);
	check('bundled script imported + bundled its helper module', (await get(page, '__bundledHelperMarked')) === 1);

	// SPA away and back (sidebar links -> SPA router)
	await page.click('aside nav a[href="/dashboard/orders"]');
	await page.waitForSelector('[data-filterbar]', { timeout: 4000 });
	await page.click('aside nav a[href="/dashboard/settings"]');
	await page.waitForSelector('[data-counter]', { timeout: 4000 });
	await page.waitForTimeout(300);

	check('SPA arrival: inline (no data-rerun) did NOT re-run', (await get(page, '__settingsInline')) === 1, `=${await get(page, '__settingsInline')}`);
	check('SPA arrival: data-rerun script re-ran', (await get(page, '__rerunCount')) === 2, `=${await get(page, '__rerunCount')}`);
	check('SPA arrival: bundled module de-duped (ran once)', (await get(page, '__bundledRan')) === 1, `=${await get(page, '__bundledRan')}`);

	// second SPA round trip: data-rerun keeps incrementing, bundled stays 1
	await page.click('aside nav a[href="/dashboard/orders"]');
	await page.waitForSelector('[data-filterbar]', { timeout: 4000 });
	await page.click('aside nav a[href="/dashboard/settings"]');
	await page.waitForSelector('[data-counter]', { timeout: 4000 });
	await page.waitForTimeout(200);
	check('SPA arrival 2: data-rerun incremented again', (await get(page, '__rerunCount')) === 3, `=${await get(page, '__rerunCount')}`);
	check('SPA arrival 2: bundled module still de-duped', (await get(page, '__bundledRan')) === 1, `=${await get(page, '__bundledRan')}`);

	// full reload resets everything
	await page.goto(base + '/dashboard/settings', { waitUntil: 'load' });
	await page.waitForTimeout(200);
	check('full reload: bundled + inline re-run fresh', (await get(page, '__bundledRan')) === 1 && (await get(page, '__settingsInline')) === 1);

	check('no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
	await page.close();
} finally {
	await browser.close();
}
console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL SCRIPT CHECKS PASSED' : failures + ' SCRIPT CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
