// Mixed-mode (islands on a csr=true page) + opt-in router (MPA handoff) checks.
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const out = [];
function check(name, cond, extra = '') {
	if (!cond) failures++;
	out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
	// ---------- Mixed mode: island on the csr=true /kit page ----------
	{
		const page = await browser.newPage();
		const errs = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto(base + '/kit', { waitUntil: 'networkidle' });
		await sleep(500);
		check('mixed: exactly one counter in DOM (no duplicate)', (await page.locator('[data-counter]').count()) === 1);
		// csr=true → ogygia steps aside: the island compiled to a plain component, so there is NO
		// <ogygia-region> at all (zero ogygia on the page). Kit hydrates the plain component itself.
		check('mixed: NO ogygia-region on the csr=true page (zero ogygia)', (await page.locator('ogygia-region').count()) === 0);
		const btn = page.locator('[data-counter] button');
		await btn.click();
		await btn.click();
		check('mixed: island interactive via Kit hydration', (await btn.textContent()).includes('count is 44'));
		// real $app/state in a normal (non-island) component
		check('mixed: normal component uses REAL $app/state', (await page.locator('[data-kit-status] strong').textContent()).includes('/kit'));
		const ks = page.locator('[data-kit-status] button');
		await ks.click();
		check('mixed: normal component interactive', (await ks.textContent()).includes('count 1'));
		check('mixed: no page errors', errs.length === 0, errs.slice(0, 2).join('; '));
		await page.close();
	}

	// ---------- Global router: SPA everywhere; /plain opts out of view transitions per-page ----------
	{
		const page = await browser.newPage();
		await page.goto(base + '/', { waitUntil: 'networkidle' });
		const m1 = await page.evaluate(() => window.__marker);
		// SPA nav keeps the runtime marker (no full document reload)
		await page.click('nav a[href="/about"]');
		await page.waitForSelector('[data-clock-island]', { timeout: 3000 });
		check('router: SPA nav keeps the marker', (await page.evaluate(() => window.__marker)) === m1);

		// nav to /plain -> still SPA (router is global); the page only opts out of view transitions
		let loaded: boolean = false;
		page.on('load', () => (loaded = true));
		await page.click('nav a[href="/plain"]');
		await page.waitForSelector('[data-static-shell]', { timeout: 4000 });
		await sleep(200);
		check('router: nav to /plain stayed SPA (no document reload)', !loaded);
		check('router: at /plain', page.url().endsWith('/plain'));
		const m2 = await page.evaluate(() => window.__marker);
		check('router: SPA nav to /plain kept the runtime marker', m2 === m1);
		// island on /plain still hydrates
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 3000 });
		const pbtn = page.locator('[data-counter] button');
		await pbtn.click();
		check('router: island on /plain still hydrates & works', (await pbtn.textContent()).includes('count is 6'));
		await page.close();
	}
} finally {
	await browser.close();
}
console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL MIXED/ROUTER CHECKS PASSED' : failures + ' MIXED/ROUTER CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
