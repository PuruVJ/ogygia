// THE WAKE GATE: an island's non-interaction wake starts no earlier than a Kit page would start
// hydrating — after DOMContentLoaded and one painted frame (runtime/schedule.ts
// `after_document_painted`). The runtime boots from a module script BEFORE DOMContentLoaded; without
// the gate a `load`, in-viewport `visible` or `idle` island's code downloaded beside the page's first
// paint (background priority orders the main thread, not the network).
//
// The playground's /wake-gate page carries a module script the test HOLDS: DOMContentLoaded waits for
// every deferred script, so while it is held the document is parsed, the runtime has booted, and
// DOMContentLoaded has not fired. Proven:
//   1. no island code the runtime starts (entries, the hydrate core, their chunks) is requested
//      while the script is held, and every such request starts after DOMContentLoaded AND after the
//      first frame painted after it (resource timing, one clock);
//   2. an interaction inside that window wakes its island at once and the click replays.
// Code the HTML hints on purpose (`regions.preload` modulepreloads for `load` islands) is the
// page's choice, not a wake — it is left out of (1).
// Usage: pnpm exec playwright test wake-gate
import type { Page, Route } from '@playwright/test';
import { test, check } from './fixtures/index.ts';

const SLOW_SCRIPT_NAME = '/wake-gate-slow.js';
const SLOW_SCRIPT = `**${SLOW_SCRIPT_NAME}`;
const ISLAND_WAKES = ['load', 'visible', 'idle'] as const;

/** Hold the slow script until `release()`; resolves `held` once the browser asked for it. */
function hold_slow_script(page: Page) {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	let requested!: () => void;
	const held = new Promise<void>((r) => (requested = r));
	void page.route(SLOW_SCRIPT, async (route: Route) => {
		requested();
		await gate;
		await route.fulfill({
			contentType: 'text/javascript',
			// Stamp the first frame painted after DOMContentLoaded, on the page's own clock.
			body: `document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(() => { window.__gate_frame = performance.now(); }));`
		});
	});
	return { held, release };
}

/** Script requests the page made so far, as absolute URLs. */
async function script_requests(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		performance
			.getEntriesByType('resource')
			.filter((e) => (e as PerformanceResourceTiming).initiatorType === 'script' || e.name.endsWith('.js'))
			.map((e) => e.name)
	);
}

test.describe('wake gate: island wakes start after DOMContentLoaded and a painted frame', () => {
	test('load / visible / idle islands fetch nothing while DOMContentLoaded is held', async ({ page }) => {
		const { held, release } = hold_slow_script(page);
		await page.goto('/wake-gate', { waitUntil: 'commit' });
		await held;
		await page.waitForFunction(() => !!customElements.get('ogygia-region'));
		// Well past boot: an ungated `load` wake would have started its import long ago.
		await page.waitForTimeout(600);

		const entries = await page.evaluate(() =>
			[...document.querySelectorAll('ogygia-region[entry]')].map((r) => ({
				wake: r.getAttribute('wake'),
				url: new URL(r.getAttribute('entry')!, location.href).href
			}))
		);
		const hinted = await page.evaluate(() =>
			[...document.querySelectorAll('link[rel="modulepreload"]')].map((l) => (l as HTMLLinkElement).href)
		);
		const gated = entries.filter((e) => (ISLAND_WAKES as readonly string[]).includes(e.wake!));
		check('the page has a load, a visible and an idle island', gated.length === 3, JSON.stringify(entries));
		check(
			'held: DOMContentLoaded has not fired',
			await page.evaluate(() => performance.getEntriesByType('navigation')[0] &&
				(performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventStart === 0)
		);
		const before = await script_requests(page);
		const early = gated.filter((e) => !hinted.includes(e.url) && before.includes(e.url));
		check('held: no gated island entry was requested', early.length === 0, JSON.stringify(early));
		check('held: no island hydrated', (await page.locator('ogygia-region[data-hydrated]').count()) === 0);

		release();
		for (const wake of ISLAND_WAKES) {
			await page.waitForSelector(`ogygia-region[wake="${wake}"][data-hydrated]`, { timeout: 10_000 });
		}
		const timing = await page.evaluate(() => {
			const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
			return {
				dcl: nav.domContentLoadedEventEnd,
				frame: (window as { __gate_frame?: number }).__gate_frame ?? Infinity,
				resources: performance
					.getEntriesByType('resource')
					.map((e) => ({ name: e.name, start: e.startTime }))
			};
		});
		// Every script the runtime fetched for a wake: the gated entries plus whatever they (and the
		// hydrate core) pulled in — everything requested after the held window that the HTML did not hint.
		const boot = new Set(before);
		const woke = timing.resources.filter(
			(r) =>
				r.name.endsWith('.js') &&
				!r.name.endsWith(SLOW_SCRIPT_NAME) && // the held script itself (its entry lands on release)
				!boot.has(r.name) &&
				!hinted.includes(r.name)
		);
		check('released: the wakes fetched island code', woke.length > 0, JSON.stringify(timing.resources));
		const too_soon = woke.filter((r) => r.start < timing.dcl || r.start < timing.frame);
		check(
			'released: every wake request started after DOMContentLoaded and a painted frame',
			too_soon.length === 0,
			JSON.stringify({ dcl: timing.dcl, frame: timing.frame, too_soon })
		);
	});

	test('an interaction before DOMContentLoaded wakes its island at once and replays', async ({ page }) => {
		const { held, release } = hold_slow_script(page);
		await page.goto('/wake-gate', { waitUntil: 'commit' });
		await held;
		await page.waitForFunction(() => !!customElements.get('ogygia-region'));
		await page.locator('[data-i-btn]').click();
		await page.waitForSelector('ogygia-region[wake="interaction"][data-hydrated]', { timeout: 10_000 });
		check(
			'the interaction island woke while DOMContentLoaded was still held',
			await page.evaluate(
				() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventStart === 0
			)
		);
		check('the waking click replayed (count 1)', (await page.locator('[data-i-count]').innerText()) === '1');
		check('no gated island hydrated yet', (await page.locator('ogygia-region[wake="load"][data-hydrated]').count()) === 0);
		release();
		await page.waitForSelector('ogygia-region[wake="load"][data-hydrated]', { timeout: 10_000 });
	});
});
