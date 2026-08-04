// Playwright checks for the dashboard testbed (Part A shims + Part B patterns).
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
	// ---------- Order detail: page shim on the client ----------
	{
		const page = await browser.newPage();
		const errs = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto(base + '/dashboard/orders/5', { waitUntil: 'networkidle' });
		await page.waitForSelector('ogygia-region[data-hydrated]', { timeout: 4000 }).catch(() => {});
		const od = page.locator('[data-orderdetail]');
		check('orderdetail: page.params.id via shim', (await od.locator('h2').textContent()).includes('Order #5'));
		check('orderdetail: page.data Date survived to client', (await od.locator('[data-created]').textContent()).includes('2024-01-01T14:34:15'));
		check('orderdetail: page.data Map survived to client', /Line items \(Map\): 6/.test(await od.locator('[data-lineitems]').textContent()));
		check('orderdetail: no page errors from $app/state shim', errs.length === 0, errs.slice(0, 2).join('; '));

		// prev/next SPA nav updates the page-shim island content
		const m1 = await page.evaluate(() => window.__marker);
		await page.click('[data-order-nav] a[href="/dashboard/orders/6"]');
		await page.waitForFunction(() => document.querySelector('[data-orderdetail] h2')?.textContent.includes('#6'), { timeout: 4000 });
		check('orderdetail: SPA nav to #6 updates page-shim island', (await od.locator('h2').textContent()).includes('Order #6'));
		check('orderdetail: SPA nav kept marker (no reload)', (await page.evaluate(() => window.__marker)) === m1);
		await page.close();
	}

	// ---------- Orders list: FilterBar goto() shim + DataTable client sort ----------
	{
		const page = await browser.newPage();
		const errs = [];
		page.on('pageerror', (e) => errs.push(e.message));
		await page.goto(base + '/dashboard/orders', { waitUntil: 'networkidle' });
		await page.waitForSelector('[data-filterbar][data-status]', { timeout: 4000 }).catch(() => {});

		// client-side sort in the DataTable island
		const firstIdBefore = await page.locator('[data-datatable] tbody tr').first().getAttribute('data-row-id');
		await page.click('[data-datatable] button[data-sort="total"]');
		await sleep(150);
		const firstIdAfterSort = await page.locator('[data-datatable] tbody tr').first().getAttribute('data-row-id');
		check('datatable: client-side sort reorders rows', firstIdBefore !== firstIdAfterSort, `${firstIdBefore}->${firstIdAfterSort}`);

		// FilterBar island calls goto() (navigation shim) -> SPA nav changes ?status
		const m1 = await page.evaluate(() => window.__marker);
		await page.click('[data-filterbar] button[data-status="shipped"]');
		await page.waitForFunction(() => location.search.includes('status=shipped'), { timeout: 4000 }).catch(() => {});
		check('filterbar: island goto() changed URL to ?status=shipped', page.url().includes('status=shipped'));
		check('filterbar: goto() was SPA (marker kept)', (await page.evaluate(() => window.__marker)) === m1);
		// wait for the SPA body swap to bring in the server-re-rendered meta
		await page
			.waitForFunction(() => document.querySelector('[data-orders-meta]')?.textContent.includes('status shipped'), { timeout: 4000 })
			.catch(() => {});
		const meta = await page.locator('[data-orders-meta]').textContent();
		check('filterbar: server re-rendered filtered list (status shipped)', /status shipped/.test(meta));
		check('orders: no page errors from $app/navigation shim', errs.length === 0, errs.slice(0, 2).join('; '));
		await page.close();
	}

	// ---------- Dashboard sidebar SPA nav + analytics visible chart ----------
	{
		const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
		await page.goto(base + '/dashboard/orders', { waitUntil: 'networkidle' });
		const m1 = await page.evaluate(() => window.__marker);
		await page.click('aside nav a[href="/dashboard/analytics"]');
		await page.waitForSelector('.spacer', { timeout: 4000 });
		check('sidebar: SPA nav to analytics (marker kept)', (await page.evaluate(() => window.__marker)) === m1);
		const chart = page.locator('ogygia-region[hydrate="visible"]');
		await sleep(300);
		check('analytics: chart island NOT hydrated before scroll', (await chart.getAttribute('data-hydrated')) === null);
		await page.locator('[data-barchart]').scrollIntoViewIfNeeded();
		await page.waitForSelector('ogygia-region[hydrate="visible"][data-hydrated]', { timeout: 3000 }).catch(() => {});
		check('analytics: chart island hydrated after scroll', (await chart.getAttribute('data-hydrated')) !== null);
		check('analytics: SVG bars rendered', (await page.locator('[data-barchart] rect').count()) >= 3);
		await page.close();
	}

} finally {
	await browser.close();
}
console.log(out.join('\n'));
console.log(`\n${failures === 0 ? 'ALL DASHBOARD CHECKS PASSED' : failures + ' DASHBOARD CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
