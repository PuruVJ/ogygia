// Accessibility of SPA navigation. A body swap fires no document `load`, so — unlike a full page
// navigation — a screen reader is never told the page changed, and keyboard focus is stranded on the
// old page. The router closes both gaps: a visually-hidden aria-live region announces the new title,
// and focus resets to the top of the new page (autofocus > #hash > <body>), with a carve-out for a
// focused control inside kept/persisted chrome.
// Usage: pnpm exec playwright test nav-a11y
import { test, check, sleep } from './fixtures/index.ts';

test.describe('SPA navigation accessibility', () => {
	test('announces the new page and resets focus to the top', async ({ page }) => {
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('meta[name="ogygia-router"]', { state: 'attached' });
		// Router started (click listener installed) once history.state.ogygia is set by start().
		await page.waitForFunction(
			() => (history.state as { ogygia?: boolean } | null)?.ogygia === true,
			{ timeout: 8000 }
		);

		// Put focus somewhere on the OLD page, so we can prove the nav moves it.
		await page.evaluate(() => {
			const a = document.querySelector('nav a') as HTMLElement | null;
			a?.focus();
		});
		const before = await page.evaluate(() => document.activeElement?.tagName);
		check('a nav link is focused before navigating', before === 'A', String(before));

		// SPA-navigate Home -> About (About has no autofocus and no hash).
		await page.click('nav a[href="/about"]');
		await page.waitForFunction(() => location.pathname === '/about', { timeout: 8000 });
		await sleep(120);

		// The aria-live announcer exists, is assertive+atomic, and carries the new title.
		const ann = await page.evaluate(() => {
			const el = document.querySelector('[data-ogygia-announcer]');
			return el
				? { live: el.getAttribute('aria-live'), atomic: el.getAttribute('aria-atomic'), text: el.textContent }
				: null;
		});
		const title = await page.title();
		check('announcer exists as an assertive+atomic live region', !!ann && ann.live === 'assertive' && ann.atomic === 'true', JSON.stringify(ann));
		check('announcer speaks the new page label (its title)', !!ann && !!ann.text && ann.text === (title || '/about'), `text=${ann?.text} title=${title}`);

		// Focus reset to <body> — a keyboard/AT user starts at the top of the new page.
		const active = await page.evaluate(() => document.activeElement?.tagName);
		check('focus reset to <body> after nav (no autofocus/hash)', active === 'BODY', String(active));

		// The announcer survives repeated navs (same node reused, not duplicated).
		await page.click('nav a[href="/data"]');
		await page.waitForFunction(() => location.pathname === '/data', { timeout: 8000 });
		await sleep(120);
		const count = await page.evaluate(() => document.querySelectorAll('[data-ogygia-announcer]').length);
		check('exactly one announcer node after a second nav', count === 1, `count=${count}`);
	});

	test('focus lands on a #hash target when the URL has one', async ({ page }) => {
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('meta[name="ogygia-router"]', { state: 'attached' });
		// Router started (click listener installed) once history.state.ogygia is set by start().
		await page.waitForFunction(
			() => (history.state as { ogygia?: boolean } | null)?.ogygia === true,
			{ timeout: 8000 }
		);

		// Navigate to /about#about-heading — the About shell heading carries that id, so the router's
		// hash branch focuses it (rather than resetting to <body>). Drive an injected link in-page to
		// avoid Playwright's visibility wait on a zero-box anchor.
		await page.evaluate(() => {
			const a = document.createElement('a');
			a.href = '/about#about-heading';
			a.textContent = 'to about anchor';
			document.body.appendChild(a);
			a.click();
		});
		await page.waitForFunction(() => location.pathname === '/about', { timeout: 8000 });
		await sleep(120);
		const focusedId = await page.evaluate(() => document.activeElement?.id);
		check('focus landed on the #hash target element', focusedId === 'about-heading', String(focusedId));
	});
});
