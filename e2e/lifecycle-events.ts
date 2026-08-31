// LIFECYCLE DOM EVENTS (Astro parity, og: prefixed): a body swap never executes inserted
// <script> tags, so per-navigation glue hangs off three document events — og:before-swap
// (outgoing DOM readable), og:after-swap (incoming DOM in place), og:page-load (nav complete;
// ALSO fired once on the initial load so one listener covers every page view).
// Usage: node e2e/lifecycle-events.ts [baseUrl]
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
	await page.addInitScript(() => {
		const w = window as unknown as { __og_events: Record<string, number> };
		w.__og_events = { 'og:before-swap': 0, 'og:after-swap': 0, 'og:page-load': 0 };
		for (const n of Object.keys(w.__og_events))
			document.addEventListener(n, () => w.__og_events[n]++);
	});
	await page.goto(base + '/about', { waitUntil: 'networkidle' });
	await page.waitForTimeout(300);
	const initial = await page.evaluate(
		() => (window as unknown as { __og_events: Record<string, number> }).__og_events
	);
	check('INITIAL load fires og:page-load (once)', initial['og:page-load'] === 1, JSON.stringify(initial));
	check('no swap events before any navigation', initial['og:before-swap'] === 0 && initial['og:after-swap'] === 0);

	await page.click('a[href="/"]');
	await page.waitForTimeout(600);
	const after = await page.evaluate(
		() => (window as unknown as { __og_events: Record<string, number> }).__og_events
	);
	check('SPA nav fires og:before-swap once', after['og:before-swap'] === 1, JSON.stringify(after));
	check('SPA nav fires og:after-swap once', after['og:after-swap'] === 1);
	check('SPA nav fires og:page-load (initial + nav = 2)', after['og:page-load'] === 2);
	// ordering sanity: page-load implies the body already swapped
	check('same-document survived (SPA, not a full reload)', await page.evaluate(() => history.state?.ogygia === true));
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL LIFECYCLE CHECKS PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
