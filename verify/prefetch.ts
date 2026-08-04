// Router prefetch parity (task 4): the SPA router honours `data-sveltekit-preload-data` /
// `-code` (hover/tap/eager/viewport, nearest-ancestor inheritance, off/false) by warming its
// page-HTML cache. Asserts: hover fires the HTML fetch; a click swaps from cache with NO second
// fetch; tap does not fetch on hover but does on press; `off` overrides an ancestor `hover`;
// `eager` warms on load; `viewport` warms when scrolled into view.
// Usage: node verify/prefetch.ts [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out: string[] = [];
function check(name: string, cond: unknown, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
	// SPA page-HTML prefetches carry the `x-ogygia-spa` header; count document requests per pathname.
	const reqs: string[] = [];
	page.on('request', (r) => {
		if (r.headers()['x-ogygia-spa'] === '1') reqs.push(new URL(r.url()).pathname);
	});
	const countTo = (p: string) => reqs.filter((u) => u === p).length;

	await page.goto(base + '/prefetch', { waitUntil: 'networkidle' });
	await sleep(300);

	// --- eager: warmed on load without interaction ---
	check('eager code link warmed /server on load', countTo('/server') >= 1, `count=${countTo('/server')}`);

	// --- hover: fires the HTML fetch ---
	check('nothing fetched for /about before hover', countTo('/about') === 0);
	await page.hover('[data-prefetch-hover]');
	await page.waitForResponse((r) => new URL(r.url()).pathname === '/about', { timeout: 4000 }).catch(() => {});
	check('hover fires the /about HTML fetch', countTo('/about') === 1, `count=${countTo('/about')}`);

	// --- click swaps from cache without a second fetch ---
	await page.click('[data-prefetch-hover]');
	await page.waitForFunction(() => location.pathname === '/about', { timeout: 4000 }).catch(() => {});
	await sleep(300);
	check('navigated to /about', new URL(page.url()).pathname === '/about');
	check('click swapped from cache — still exactly ONE /about fetch (no second)', countTo('/about') === 1, `count=${countTo('/about')}`);

	// back to the prefetch page for the remaining triggers
	await page.goBack();
	await page.waitForFunction(() => location.pathname === '/prefetch', { timeout: 4000 }).catch(() => {});
	await sleep(200);

	// --- off overrides an ancestor hover: hovering does NOT fetch /data ---
	const dataBefore = countTo('/data');
	await page.hover('[data-prefetch-off]');
	await sleep(500);
	check('off overrides ancestor hover — no /data fetch on hover', countTo('/data') === dataBefore, `count=${countTo('/data')}`);

	// --- tap: does not fetch on hover, fetches on press ---
	const formsBeforeHover = countTo('/forms');
	await page.hover('[data-prefetch-tap]');
	await sleep(400);
	check('tap link does NOT fetch on hover', countTo('/forms') === formsBeforeHover, `count=${countTo('/forms')}`);
	await page.dispatchEvent('[data-prefetch-tap]', 'mousedown');
	await page.waitForResponse((r) => new URL(r.url()).pathname === '/forms', { timeout: 4000 }).catch(() => {});
	check('tap link fetches on press (mousedown)', countTo('/forms') >= 1, `count=${countTo('/forms')}`);

	// --- viewport: warmed when scrolled into view ---
	check('nothing fetched for /nested before scroll', countTo('/nested') === 0, `count=${countTo('/nested')}`);
	await page.locator('[data-prefetch-viewport]').scrollIntoViewIfNeeded();
	await page.waitForResponse((r) => new URL(r.url()).pathname === '/nested', { timeout: 4000 }).catch(() => {});
	check('viewport code link warms /nested after scroll', countTo('/nested') >= 1, `count=${countTo('/nested')}`);

	await page.close();
} finally {
	await browser.close();
}
console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PREFETCH CHECKS PASSED' : failures + ' PREFETCH CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
