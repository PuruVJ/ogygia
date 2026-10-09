// THE ROUTER LANDS WHERE A NAVIGATION WOULD (runtime/router-nav.ts `nav_headers`, the hand-offs,
// runtime/router.ts `nav_target`).
//
//   1. Every router page fetch (nav, prefetch, history) sends the browser's DOCUMENT `Accept`.
//      `fetch` alone sends `*/*`, and servers answer that differently: a field app 302'd `*/*` home
//      while serving `text/html` its page — the router followed the redirect, rewrote the address
//      bar to the home page and never navigated.
//   2. A page the router will not render (another application behind the same origin) is handed to
//      the browser as a navigation to the address the visitor CLICKED, never to where the router's
//      own fetch was redirected.
//   3. A web-component link that re-dispatches the visitor's click on its inner `<a>` starts ONE
//      navigation, not two (the second used to abort the first and fetch again).
//   4. A beforeNavigate cancel does not leave that swallow armed: the next click navigates.
// The foreign server and the web component are faked by the test (page.route / an init script).
// Usage: pnpm exec playwright test router-document-fetch
import type { Page, Request } from '@playwright/test';
import { test, check } from './fixtures/index.ts';

/** What Chromium sends for a top-level document navigation. */
const DOCUMENT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const FOREIGN = '**/router-links/foreign/**';
const FOREIGN_PATH = '/router-links/foreign/docs/';
const FOREIGN_HTML = '<!doctype html><html><head><title>foreign</title></head><body><h1 data-foreign-page>foreign app</h1></body></html>';

/** Requests the router made for a page (its fetches carry `x-ogygia-spa`). */
function spa_requests(page: Page): Request[] {
	const out: Request[] = [];
	page.on('request', (r) => {
		if (r.headers()['x-ogygia-spa']) out.push(r);
	});
	return out;
}

/** The re-dispatching web-component link: on the visitor's (trusted) click it clicks its inner
 *  `<a>` again a few ms later — what design-system button links do. */
const RELINK = () => {
	customElements.define(
		'x-relink',
		class extends HTMLElement {
			connectedCallback() {
				this.addEventListener('click', (e) => {
					if (!e.isTrusted) return;
					setTimeout(() => this.querySelector('a')?.click(), 5);
				});
			}
		}
	);
};

async function open(page: Page) {
	await page.goto('/router-links', { waitUntil: 'networkidle' });
	await page.waitForFunction(() => !!customElements.get('ogygia-region') || !!document.querySelector('meta[name="ogygia-router"]'));
}

test.describe('the router fetches a page the way the browser fetches a document', () => {
	test('nav, prefetch and history fetches all send the document Accept', async ({ page }) => {
		const reqs = spa_requests(page);
		await open(page);
		await page.locator('[data-plain]').hover(); // prefetch
		await page.waitForTimeout(400);
		await page.locator('[data-plain]').click(); // nav (from the prefetch cache, or a fetch)
		await page.waitForSelector('#about-heading');
		await page.goBack(); // history
		await page.waitForSelector('[data-router-links]');
		await page.waitForTimeout(300);
		const purposes = reqs.map((r) => r.headers()['x-ogygia-purpose'] ?? 'nav');
		check('a prefetch and a history fetch were made', purposes.includes('prefetch') && purposes.includes('history'), purposes.join(','));
		const wrong = reqs.filter((r) => r.headers()['accept'] !== DOCUMENT_ACCEPT);
		check(
			'every router page fetch sends the document Accept',
			reqs.length > 0 && wrong.length === 0,
			wrong.map((r) => `${r.url()} accept=${r.headers()['accept']}`).join('\n')
		);
	});

	test('a server that redirects */* but serves text/html: the click lands on the page a navigation gets', async ({ page }) => {
		const seen: Array<{ accept: string; spa: boolean }> = [];
		await page.route(FOREIGN, (route) => {
			const h = route.request().headers();
			seen.push({ accept: h['accept'] ?? '', spa: !!h['x-ogygia-spa'] });
			if (!(h['accept'] ?? '').includes('text/html'))
				return route.fulfill({ status: 302, headers: { location: '/' } });
			return route.fulfill({ status: 200, contentType: 'text/html', body: FOREIGN_HTML });
		});
		await open(page);
		await page.locator('[data-foreign]').click();
		await page.waitForSelector('[data-foreign-page]', { timeout: 10_000 });
		check('the address is the clicked one, not the redirect target', new URL(page.url()).pathname === FOREIGN_PATH, page.url());
		check('the foreign document was loaded by the browser (a real navigation)', seen.some((s) => !s.spa), JSON.stringify(seen));
		check('no request was answered with the */* redirect', seen.every((s) => s.accept.includes('text/html')), JSON.stringify(seen));
	});

	test('a page the router will not render is handed off to the CLICKED address, not the fetch’s redirect', async ({ page }) => {
		// Only the router's fetch is redirected (a server keying on its own header): the browser's
		// own request for the clicked address must be what the visitor ends up on.
		// The redirect target is a real non-ogygia document (routes/router-links/elsewhere/+server.ts):
		// the router's fetch lands on it and hands off.
		await page.route(FOREIGN, (route) =>
			route.request().headers()['x-ogygia-spa']
				? route.fulfill({ status: 302, headers: { location: '/router-links/elsewhere' } })
				: route.fulfill({ status: 200, contentType: 'text/html', body: FOREIGN_HTML })
		);
		await open(page);
		const before = await page.evaluate(() => history.length);
		await page.locator('[data-foreign]').click();
		await page.waitForSelector('[data-foreign-page]', { timeout: 10_000 });
		check('landed on the clicked address', new URL(page.url()).pathname === FOREIGN_PATH, page.url());
		check('one history entry for one click', (await page.evaluate(() => history.length)) === before + 1);
	});

	test('a web-component link that re-dispatches its click: one fetch, one history entry', async ({ page }) => {
		await page.addInitScript(RELINK);
		const reqs = spa_requests(page);
		await open(page);
		const before = await page.evaluate(() => history.length);
		const n0 = reqs.length;
		await page.locator('[data-relink]').click();
		await page.waitForSelector('#about-heading');
		await page.waitForTimeout(300);
		const navs = reqs.slice(n0).filter((r) => new URL(r.url()).pathname === '/about' && !r.headers()['x-ogygia-purpose']);
		check('exactly one navigation fetch', navs.length === 1, String(navs.length));
		check('exactly one history entry', (await page.evaluate(() => history.length)) === before + 1);
	});

	test('a beforeNavigate cancel does not leave the link swallowed', async ({ page }) => {
		await open(page);
		await page.evaluate(() => {
			const nav = (globalThis as unknown as Record<symbol, { beforeNavigate(fn: (n: { cancel(): void }) => void): () => void }>)[
				Symbol.for('ogygia.nav')
			];
			let once = true;
			nav.beforeNavigate((n) => {
				if (once) {
					once = false;
					n.cancel();
				}
			});
		});
		await page.locator('[data-plain]').click();
		await page.waitForTimeout(400);
		check('the cancelled click stayed', new URL(page.url()).pathname === '/router-links');
		await page.locator('[data-plain]').click();
		await page.waitForSelector('#about-heading', { timeout: 10_000 });
		check('the next click on the same link navigates', new URL(page.url()).pathname === '/about', page.url());
	});
});
