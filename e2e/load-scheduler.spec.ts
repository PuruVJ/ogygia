// THE LOAD SCHEDULER — island code waits for the page's critical resource.
//
// REGRESSION (a field report, 2026-10-07): on country home pages the hero image (the LCP, marked
// fetchpriority="high") shared its bandwidth with the islands' code once the wake gate opened (the
// painted document): 206 requests, 888 KB, the hero 1.19 s → 2.27 s, LCP about 1 s worse.
// runtime/load-scheduler.ts now holds island code (and background work) until the page's marked
// critical resources have arrived — or the visitor's first input, or a cap.
//
// The playground's /load-scheduler page has a `fetchpriority="high"` hero the test HOLDS, plus a
// `load`, a `visible` and an `idle` island and an `interaction` one. Proven:
//   1. no island entry is requested while the hero is held; all of them after it arrived;
//   2. a click while the hero is held wakes the interaction island at once (and, being the first
//      input, lets the others go too: the browser has stopped measuring LCP);
//   3. a hero that never arrives holds island code no longer than the cap.
// Usage: pnpm exec playwright test load-scheduler
import type { Page, Route } from '@playwright/test';
import { test, check } from './fixtures/index.ts';

const HERO = '**/load-scheduler-hero.png';
// a 1×1 transparent PNG
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

function hold_hero(page: Page) {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	void page.route(HERO, async (route: Route) => {
		await gate;
		await route.fulfill({ contentType: 'image/png', body: PNG });
	});
	return release;
}

/** The island entries the page carries, and when each was requested (resource timing). */
async function island_requests(page: Page) {
	return page.evaluate(() => {
		const files = [...document.querySelectorAll('ogygia-region[entry]')].map((r) => ({
			wake: r.getAttribute('wake'),
			file: new URL(r.getAttribute('src') ?? r.getAttribute('entry')!, location.href).href
		}));
		const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
		const hero = res.find((e) => e.name.includes('load-scheduler-hero.png'));
		return {
			hero_end: hero ? hero.responseEnd : null,
			islands: files.map((f) => ({
				...f,
				start: res.find((e) => e.name === f.file)?.startTime ?? null
			}))
		};
	});
}

test.describe('load scheduler: island code waits for the page’s critical resource', () => {
	test('nothing island-shaped downloads while the hero is held; everything wakes after it', async ({
		page
	}) => {
		const release = hold_hero(page);
		await page.goto('/load-scheduler', { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => !!customElements.get('ogygia-region'));
		await page.waitForTimeout(800); // well past the painted frame: the old gate had opened by now
		const held = await island_requests(page);
		const early = held.islands.filter((i) => i.wake !== 'interaction' && i.start !== null);
		check(
			'held: no load / visible / idle island entry was requested',
			early.length === 0,
			JSON.stringify(early)
		);
		check(
			'held: no island hydrated',
			(await page.locator('ogygia-region[data-hydrated]').count()) === 0
		);

		release();
		for (const wake of ['load', 'visible', 'idle'])
			await page.waitForSelector(`ogygia-region[wake="${wake}"][data-hydrated]`, {
				timeout: 10_000
			});
		const after = await island_requests(page);
		const woke = after.islands.filter((i) => i.wake !== 'interaction');
		check('released: the hero arrived', after.hero_end !== null);
		check(
			'released: every island entry was requested after the hero arrived',
			woke.every((i) => i.start !== null && i.start >= (after.hero_end ?? Infinity) - 1),
			JSON.stringify(after)
		);
		check(
			'released: the sleeping interaction island downloaded nothing',
			after.islands.find((i) => i.wake === 'interaction')?.start === null
		);
	});

	test('a click while the hero is held wakes its island at once', async ({ page }) => {
		const release = hold_hero(page);
		await page.goto('/load-scheduler', { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => !!customElements.get('ogygia-region'));
		await page.waitForTimeout(300);
		await page.locator('[data-i-btn]').click();
		await page.waitForSelector('ogygia-region[wake="interaction"][data-hydrated]', {
			timeout: 10_000
		});
		check(
			'the waking click replayed (count 1)',
			(await page.locator('[data-i-count]').innerText()) === '1'
		);
		// the first input also ended the critical wait (the browser stopped measuring LCP)
		await page.waitForSelector('ogygia-region[wake="load"][data-hydrated]', { timeout: 10_000 });
		check('the hero is still held', (await island_requests(page)).hero_end === null);
		release();
	});

	test('a hero that never arrives holds island code no longer than the cap', async ({ page }) => {
		hold_hero(page); // never released
		const t0 = Date.now();
		await page.goto('/load-scheduler', { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('ogygia-region[wake="load"][data-hydrated]', { timeout: 10_000 });
		const waited = Date.now() - t0;
		check('the load island woke after the cap, not before', waited >= 2400, String(waited));
		check('and not long after it', waited < 7000, String(waited));
	});
});
