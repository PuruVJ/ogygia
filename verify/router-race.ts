// P2: overlapping SPA navigations must not leave URL ≠ DOM (last-nav-wins).
// Usage: node verify/router-race.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
function check(name, cond, extra = '') {
	if (!cond) failures++;
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('meta[name="ogygia-router"]', { state: 'attached' });

	// /forms is heavier; /data is light — classic last-fetch-wins repro from the audit.
	await page.evaluate(() => {
		(document.querySelector('a[href="/forms"]') as HTMLAnchorElement | null)?.click();
	});
	await page.waitForTimeout(40);
	await page.evaluate(() => {
		(document.querySelector('a[href="/data"]') as HTMLAnchorElement | null)?.click();
	});

	await page.waitForURL('**/data', { timeout: 8000 }).catch(() => {});
	await page.waitForTimeout(800);

	const path = await page.evaluate(() => location.pathname);
	const h1 = ((await page.locator('h1').first().textContent().catch(() => '')) || '').trim();

	check('URL settled on last navigation (/data)', path === '/data', path);
	check(
		'DOM matches URL (not forms Guestbook heading)',
		path === '/data' && !/classic form actions/i.test(h1),
		`path=${path} h1=${h1}`
	);
} finally {
	await browser.close();
}

console.log(failures === 0 ? '\nALL ROUTER-RACE CHECKS PASSED' : `\n${failures} ROUTER-RACE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
