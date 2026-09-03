// Router prefetch parity (task 4): the SPA router honours `data-sveltekit-preload-data` /
// `-code` (hover/tap/eager/viewport, nearest-ancestor inheritance, off/false) by warming its
// page-HTML cache. Asserts: hover fires the HTML fetch; a click swaps from cache with NO second
// fetch; tap does not fetch on hover but does on press; `off` overrides an ancestor `hover`;
// `eager` warms on load; `viewport` warms when scrolled into view.
// Usage: pnpm exec playwright test prefetch
import { test, check, sleep } from './fixtures/index.ts';

test.describe('router preload hover/click/eager/viewport/tap/off', () => {
	test.use({ viewport: { width: 1000, height: 700 } });

	test('eager / hover / click-from-cache / off / tap / viewport all warm (or not) the page-HTML cache', async ({
		page
	}) => {
		// SPA page-HTML prefetches carry the `x-ogygia-spa` header; count document requests per pathname.
		// `x-ogygia-purpose` names WHY (prefetch / history) so a server can skip speculative side effects.
		const reqs: string[] = [];
		const purposed: Array<{ path: string; purpose: string | undefined }> = [];
		page.on('request', (r) => {
			if (r.headers()['x-ogygia-spa'] !== '1') return;
			const path = new URL(r.url()).pathname;
			reqs.push(path);
			purposed.push({ path, purpose: r.headers()['x-ogygia-purpose'] });
		});
		const count_to = (p: string) => reqs.filter((u) => u === p).length;
		const purpose_of = (p: string) => purposed.filter((x) => x.path === p).map((x) => x.purpose);

		await page.goto('/prefetch', { waitUntil: 'networkidle' });
		await sleep(300);

		// --- eager: warmed on load without interaction ---
		check(
			'eager code link warmed /server on load',
			count_to('/server') >= 1,
			`count=${count_to('/server')}`
		);
		check(
			'eager warm is marked x-ogygia-purpose: prefetch',
			purpose_of('/server').includes('prefetch'),
			purpose_of('/server').join(',')
		);

		// --- hover: fires the HTML fetch ---
		check('nothing fetched for /about before hover', count_to('/about') === 0);
		await page.hover('[data-prefetch-hover]');
		await page
			.waitForResponse((r) => new URL(r.url()).pathname === '/about', { timeout: 4000 })
			.catch(() => {});
		check(
			'hover fires the /about HTML fetch',
			count_to('/about') === 1,
			`count=${count_to('/about')}`
		);
		check(
			'hover prefetch is marked x-ogygia-purpose: prefetch',
			purpose_of('/about').includes('prefetch'),
			purpose_of('/about').join(',')
		);

		// --- click swaps from cache without a second fetch ---
		await page.click('[data-prefetch-hover]');
		await page
			.waitForFunction(() => location.pathname === '/about', { timeout: 4000 })
			.catch(() => {});
		await sleep(300);
		check('navigated to /about', new URL(page.url()).pathname === '/about');
		check(
			'click swapped from cache — still exactly ONE /about fetch (no second)',
			count_to('/about') === 1,
			`count=${count_to('/about')}`
		);

		// back to the prefetch page for the remaining triggers
		await page.goBack();
		await page
			.waitForFunction(() => location.pathname === '/prefetch', { timeout: 4000 })
			.catch(() => {});
		await sleep(200);

		// --- history: a back/forward restore re-fetches and is marked so the server can skip
		// side effects the visitor already fired on the first visit ---
		check(
			'back/forward restore is marked x-ogygia-purpose: history',
			purpose_of('/prefetch').includes('history'),
			purpose_of('/prefetch').join(',')
		);

		// --- off overrides an ancestor hover: hovering does NOT fetch /data ---
		const dataBefore = count_to('/data');
		await page.hover('[data-prefetch-off]');
		await sleep(500);
		check(
			'off overrides ancestor hover — no /data fetch on hover',
			count_to('/data') === dataBefore,
			`count=${count_to('/data')}`
		);

		// --- tap: does not fetch on hover, fetches on press ---
		const formsBeforeHover = count_to('/forms');
		await page.hover('[data-prefetch-tap]');
		await sleep(400);
		check(
			'tap link does NOT fetch on hover',
			count_to('/forms') === formsBeforeHover,
			`count=${count_to('/forms')}`
		);
		await page.dispatchEvent('[data-prefetch-tap]', 'mousedown');
		await page
			.waitForResponse((r) => new URL(r.url()).pathname === '/forms', { timeout: 4000 })
			.catch(() => {});
		check(
			'tap link fetches on press (mousedown)',
			count_to('/forms') >= 1,
			`count=${count_to('/forms')}`
		);

		// --- viewport: warmed when scrolled into view ---
		check(
			'nothing fetched for /nested before scroll',
			count_to('/nested') === 0,
			`count=${count_to('/nested')}`
		);
		await page.locator('[data-prefetch-viewport]').scrollIntoViewIfNeeded();
		await page
			.waitForResponse((r) => new URL(r.url()).pathname === '/nested', { timeout: 4000 })
			.catch(() => {});
		check(
			'viewport code link warms /nested after scroll',
			count_to('/nested') >= 1,
			`count=${count_to('/nested')}`
		);
	});
});
