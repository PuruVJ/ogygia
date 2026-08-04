// Playwright browser checks. Usage: node verify/browser.mjs [baseUrl]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:3051';
let failures = 0;
const results = [];
function check(name, cond, extra = '') {
	const ok = !!cond;
	results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
	if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
try {
	// ---------- Home: load-strategy hydration + interactivity ----------
	{
		const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
		const logs = [];
		page.on('console', (m) => logs.push(m.text()));
		await page.goto(base + '/', { waitUntil: 'networkidle' });

		const counter = page.locator('[data-counter] button').first();
		await counter.waitFor();
		check('home: counter SSR text', (await counter.textContent()).includes('count is 10'));
		await counter.click();
		await counter.click();
		check('home: counter hydrated & interactive', (await counter.textContent()).includes('count is 12'));

		// visible strategy: below-fold island NOT hydrated until scrolled into view.
		// (checked BEFORE interacting with islands lower on the page, which would scroll it in)
		const visIsland = page.locator('o-region[hydrate="visible"]', {
			has: page.locator('[data-visible-island]')
		});
		await sleep(400);
		check('home: visible island NOT hydrated before scroll', (await visIsland.getAttribute('data-hydrated')) === null, 'hydrated=' + JSON.stringify(await visIsland.getAttribute('data-hydrated')));

		// devalue revival: click reveals a client-computed value; island must be hydrated
		const dv = page.locator('[data-devalue]');
		check('home: devalue island Date instanceof true (client)', (await dv.locator('[data-date]').textContent()).includes('instanceof Date: true'));
		await dv.locator('button').click();
		check('home: devalue island hydrated (button works)', (await dv.locator('button').textContent()).includes('revived? true'));
		check('home: devalue Map revived (client)', (await dv.locator('[data-map]').textContent()).includes('instanceof Map: true'));
		check('home: devalue Set revived (client)', (await dv.locator('[data-set]').textContent()).includes('instanceof Set: true'));
		check('home: devalue BigInt revived (client)', (await dv.locator('[data-big]').textContent()).includes('typeof bigint'));

		const vis = page.locator('[data-visible-island]');
		await vis.scrollIntoViewIfNeeded();
		await page.waitForFunction(() => {
			const el = [...document.querySelectorAll('o-region[hydrate="visible"]')].find((n) =>
				n.querySelector('[data-visible-island]')
			);
			return el && el.hasAttribute('data-hydrated');
		}, { timeout: 3000 });
		check('home: visible island hydrated AFTER scroll', (await visIsland.getAttribute('data-hydrated')) !== null);
		check('home: visible island logged on hydrate', logs.some((l) => l.includes('visible island hydrated')));

		// per-use strategy: the SAME Counter module imported with island:'visible'
		const lazyIsland = page.locator('o-region', { hasText: 'Same module, visible strategy' });
		await lazyIsland.scrollIntoViewIfNeeded();
		await page.waitForFunction(() => {
			const el = [...document.querySelectorAll('o-region')].find((n) =>
				/Same module, visible/.test(n.textContent)
			);
			return el && el.hasAttribute('data-hydrated');
		}, { timeout: 3000 }).catch(() => {});
		const lazyBtn = lazyIsland.locator('button');
		await lazyBtn.click();
		check('home: per-use strategy (same module, visible) hydrated & interactive', /count is 100/.test(await lazyBtn.textContent()));

		await page.close();
	}

	// ---------- Media strategy: narrow viewport hydrates ----------
	{
		const page = await browser.newPage({ viewport: { width: 500, height: 700 } });
		await page.goto(base + '/', { waitUntil: 'networkidle' });
		await page.waitForSelector('o-region[hydrate*="max-width"][data-hydrated]', { timeout: 3000 }).catch(() => {});
		const media = page.locator('o-region[hydrate*="max-width"]');
		check('home(narrow): media island hydrated when query matches', (await media.getAttribute('data-hydrated')) !== null);
		await page.close();

		const wide = await browser.newPage({ viewport: { width: 1200, height: 700 } });
		await wide.goto(base + '/', { waitUntil: 'networkidle' });
		await sleep(500);
		const media2 = wide.locator('o-region[hydrate*="max-width"]');
		check('home(wide): media island NOT hydrated when query does not match', (await media2.getAttribute('data-hydrated')) === null);
		await wide.close();
	}

	// ---------- SPA navigation: marker persists, no full reload ----------
	{
		const page = await browser.newPage();
		await page.goto(base + '/', { waitUntil: 'networkidle' });
		const marker1 = await page.evaluate(() => window.__marker);
		check('spa: runtime set window.__marker', typeof marker1 === 'number');

		let fullReload = false;
		page.on('load', () => { fullReload = true; });
		await page.click('nav a[href="/about"]');
		await page.waitForSelector('[data-clock-island]', { timeout: 3000 });
		const marker2 = await page.evaluate(() => window.__marker);
		check('spa: navigated to /about (Clock island present)', await page.locator('[data-clock-island]').count() === 1);
		check('spa: URL updated to /about', page.url().endsWith('/about'));
		check('spa: window.__marker PERSISTED (no full reload)', marker1 === marker2, `${marker1} vs ${marker2}`);
		check('spa: no full page load event fired', fullReload === false);

		// nav back home via SPA, marker still same
		await page.click('nav a[href="/"]');
		await page.waitForSelector('[data-counter]', { timeout: 3000 });
		const marker3 = await page.evaluate(() => window.__marker);
		check('spa: back to home, marker still persisted', marker1 === marker3);

		// back/forward (SPA popstate — history.back() so we don't wait on a load event)
		await page.evaluate(() => history.back());
		await page.waitForURL(/\/about$/, { timeout: 3000 }).catch(() => {});
		await page.waitForSelector('[data-clock-island]', { timeout: 3000 }).catch(() => {});
		check('spa: history back returns to /about', page.url().endsWith('/about'));
		const marker4 = await page.evaluate(() => window.__marker);
		check('spa: marker persists through back/forward', marker1 === marker4);
		await page.close();
	}

	// ---------- Remote functions in islands (SSR works; client refetch is a KNOWN LIMITATION) ----------
	{
		const page = await browser.newPage();
		// domcontentloaded (not networkidle): the live-query SSE stream stays open
		await page.goto(base + '/data', { waitUntil: 'domcontentloaded' });
		await sleep(500);
		// mode (a) resolved at SSR — the resolved data is in the served HTML.
		check('data: mode (a) resolved greeting present (SSR)', (await page.locator('[data-resolved-greeting]').textContent()).includes('Hello, world!'));
		// The /data islands DO hydrate (their custom elements connect).
		await sleep(400);
		const anyHydrated = await page.locator('o-region[data-hydrated]').count();
		check('data: islands hydrate (custom elements connect)', anyHydrated >= 1, `hydrated=${anyHydrated}`);
		await page.close();
	}
} finally {
	await browser.close();
}

console.log(results.join('\n'));
console.log(`\n${failures === 0 ? 'ALL BROWSER CHECKS PASSED' : failures + ' BROWSER CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
