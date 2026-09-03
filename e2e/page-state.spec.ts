// Playwright: `$app/state` shim exposes a real `page.url` (and siblings) inside islands.
//
//   pnpm exec playwright test page-state
//
// Locks the `$state.raw` page-store fix: `page.url.pathname` must not be empty / undefined
// after hydrate, and must track SPA navigations (island remount + fresh set_page).
import { test, check, sleep } from './fixtures/index.ts';

test.describe('page.url/params/route/status/data/form/error/state in islands', () => {
	test('the shim exposes every page.* field after hydrate and tracks an SPA nav', async ({
		page
	}) => {
		const errs: string[] = [];
		page.on('pageerror', (e) => errs.push(e.message));

		await page.goto('/dashboard/orders/5', { waitUntil: 'networkidle' });
		await page
			.waitForSelector(
				'[data-pageurl-probe][data-hydrated], ogygia-region[data-hydrated] [data-pageurl-probe]',
				{ timeout: 5000 }
			)
			.catch(() => {});
		await page.waitForSelector('[data-pageurl-probe]', { timeout: 5000 });
		await sleep(300);

		const probe = page.locator('[data-pageurl-probe]');
		const pathname = (await probe.locator('[data-pathname]').textContent()).trim();
		const href = (await probe.locator('[data-href]').textContent()).trim();
		const search = (await probe.locator('[data-search]').textContent()).trim();
		const host = (await probe.locator('[data-host]').textContent()).trim();
		const paramId = (await probe.locator('[data-param-id]').textContent()).trim();
		const routeId = (await probe.locator('[data-route-id]').textContent()).trim();
		const status = (await probe.locator('[data-status]').textContent()).trim();
		const dataKeys = (await probe.locator('[data-data-keys]').textContent()).trim();
		const form = (await probe.locator('[data-form]').textContent()).trim();
		const error = (await probe.locator('[data-error]').textContent()).trim();
		const stateType = (await probe.locator('[data-state-type]').textContent()).trim();

		check(
			'page.url.pathname is non-empty inside island',
			pathname.length > 0,
			JSON.stringify(pathname)
		);
		check('page.url.pathname matches order route', pathname === '/dashboard/orders/5', pathname);
		check(
			'page.url.href includes pathname',
			href.includes('/dashboard/orders/5'),
			href.slice(0, 80)
		);
		check('page.url.host is non-empty', host.length > 0, host);
		check('page.url.search is a string (may be empty)', typeof search === 'string');
		check('page.params.id via shim inside island', paramId === '5', paramId);
		check('page.route.id is set', routeId.length > 0 && routeId.includes('orders'), routeId);
		check('page.status is 200', status === '200', status);
		check('page.data is a readable object (keys string)', typeof dataKeys === 'string');
		check('page.form is null on GET', form === 'null', form);
		check('page.error is null on success', error === 'null', error);
		check('page.state is an object', stateType === 'object', stateType);
		check('no page errors reading page.url.*', errs.length === 0, errs.slice(0, 2).join('; '));

		// SPA nav → remount → fresh set_page → pathname / params update
		const m1 = await page.evaluate(() => window.__marker);
		await page.click('[data-order-nav] a[href="/dashboard/orders/6"]');
		await page
			.waitForFunction(
				() =>
					document.querySelector('[data-pageurl-probe] [data-pathname]')?.textContent?.trim() ===
					'/dashboard/orders/6',
				{ timeout: 5000 }
			)
			.catch(() => {});
		const pathname2 = (await probe.locator('[data-pathname]').textContent()).trim();
		const paramId2 = (await probe.locator('[data-param-id]').textContent()).trim();
		check(
			'SPA nav updates page.url.pathname inside island',
			pathname2 === '/dashboard/orders/6',
			pathname2
		);
		check('SPA nav updates page.params.id inside island', paramId2 === '6', paramId2);
		check(
			'SPA nav kept marker (no full reload)',
			(await page.evaluate(() => window.__marker)) === m1
		);

		// Query string via FilterBar goto on list page
		await page.goto('/dashboard/orders?status=shipped', { waitUntil: 'networkidle' });
		// No PageUrlProbe on list — spot-check FilterBar still works; pathname suite done above.
		await page.waitForSelector('[data-filterbar]', { timeout: 4000 }).catch(() => {});
		check(
			'orders list still loads after page-state checks',
			(await page.locator('[data-filterbar]').count()) >= 1
		);
	});
});
