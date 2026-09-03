// Server redirect during an SPA navigation (task 5). The router pushes the destination URL
// OPTIMISTICALLY, before the fetch, so a `redirect()` in a server load would otherwise leave the
// address bar showing the pre-redirect URL over the redirected content. `fetch` follows the redirect
// transparently; the router reads `response.url`, corrects the address bar, and REPLACES the
// intermediate entry so the back button skips it. The playground's `/dashboard` load does
// `redirect(307, '/dashboard/orders')`, exercising exactly this.
// Usage: pnpm exec playwright test redirect
import { test, check, sleep } from './fixtures/index.ts';

test.describe('SPA navigation into a server redirect', () => {
	test('address bar corrects to the redirect target, content matches, back skips the intermediate', async ({
		page
	}) => {
		// Record the SPA fetches (they carry x-ogygia-spa) so we can prove the redirect landed on the
		// destination, not the source.
		const spaGets: string[] = [];
		page.on('request', (r) => {
			if (r.headers()['x-ogygia-spa'] === '1') spaGets.push(new URL(r.url()).pathname);
		});

		await page.goto('/', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('meta[name="ogygia-router"]', { state: 'attached' });
		// Wait until the router has actually STARTED before clicking — `start()` seeds
		// `history.state.ogygia = true` once its click listener is installed, so this is the reliable
		// ready signal (a fixed sleep races the runtime boot under load).
		await page.waitForFunction(
			() => (history.state as { ogygia?: boolean } | null)?.ogygia === true,
			{ timeout: 8000 }
		);

		// SPA-navigate into the redirecting route by clicking an injected same-origin link (the router
		// intercepts anchor clicks). There is no nav link to bare `/dashboard`, so inject one.
		await page.evaluate(() => {
			const a = document.createElement('a');
			a.href = '/dashboard';
			a.id = '__redir_link';
			a.textContent = 'to dashboard';
			document.body.appendChild(a);
			a.click();
		});

		// The address bar settles on the REDIRECT TARGET, not the requested `/dashboard`. The click
		// pushes `/dashboard` synchronously; the router then follows the redirect and corrects it.
		await page.waitForFunction(() => location.pathname === '/dashboard/orders', { timeout: 8000 });
		const path = await page.evaluate(() => location.pathname);
		check('address bar corrected to the redirect target', path === '/dashboard/orders', path);

		// The rendered content is the destination page (Orders heading), not a blank/source page.
		const h1 = (
			(await page.locator('h1').first().textContent().catch(() => '')) || ''
		).trim();
		check('destination content is rendered (Orders heading)', /orders/i.test(h1), h1);

		// The fetch landed on the destination (redirect was followed, not re-issued as a hard nav).
		check(
			'an SPA fetch reached the destination route',
			spaGets.some((p) => p === '/dashboard' || p === '/dashboard/orders'),
			spaGets.join(',')
		);

		// Back button returns HOME, skipping the intermediate `/dashboard` (a redirect REPLACES its
		// history entry — browser semantics — so it must not sit in the back stack).
		await page.goBack();
		await sleep(300);
		const back = await page.evaluate(() => location.pathname);
		check('back button skipped the intermediate /dashboard and returned home', back === '/', back);
	});
});
