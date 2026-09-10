// LONG-TASK BUDGET on the large CMS page shape (`/bench-cms`: 21 islands — a header with a ~300 KB
// props payload, 20 blocks fed by seed references, one `$page` reader over a ~700 KB seed). The
// runtime must never make a long task of its own: hydration is one island per task (the scheduler),
// the seed and the sidecars are parsed once each, in those tasks. Measured with the Long Tasks API
// under a 4× CPU throttle (a mid-range phone), from navigation start until every island is live.
// Usage: pnpm exec playwright test long-task-budget
import { test, check } from './fixtures/index.ts';

/** The budget for any single task after the document is parsed: the Long Tasks threshold. */
const TASK_BUDGET_MS = 50;

test.describe('long-task budget: the large CMS page boots with no task over 50 ms from the runtime', () => {
	test('/bench-cms: 21 islands, seed + sidecars parsed once, no long task after DOMContentLoaded', async ({
		page
	}) => {
		// Observe from the very first script: an init script installs the observer before the runtime.
		await page.addInitScript(() => {
			const w = window as unknown as { __og_long: Array<{ start: number; dur: number }>; __og_dcl: number };
			w.__og_long = [];
			w.__og_dcl = 0;
			new PerformanceObserver((list) => {
				for (const e of list.getEntries()) w.__og_long.push({ start: e.startTime, dur: e.duration });
			}).observe({ type: 'longtask', buffered: true });
			document.addEventListener('DOMContentLoaded', () => (w.__og_dcl = performance.now()));
		});
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
		await page.goto('/bench-cms', { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(
			() => document.querySelectorAll('ogygia-region[wake="load"][data-hydrated]').length === 12,
			null,
			{ timeout: 60_000 }
		);
		await page.waitForTimeout(500);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

		const { long, dcl } = await page.evaluate(() => {
			const w = window as unknown as { __og_long: Array<{ start: number; dur: number }>; __og_dcl: number };
			return { long: w.__og_long, dcl: w.__og_dcl };
		});
		// Parsing 700 KB of HTML is the browser's task, before DOMContentLoaded; ours start after.
		const ours = long.filter((t) => t.start >= dcl);
		check(
			`no task ≥ ${TASK_BUDGET_MS} ms after DOMContentLoaded (4× CPU throttle)`,
			ours.length === 0,
			ours.map((t) => `${Math.round(t.start)}ms +${Math.round(t.dur)}ms`).join(', ')
		);
		check(
			'all 12 load islands hydrated (header, reader, 10 blocks)',
			(await page.locator('ogygia-region[wake="load"][data-hydrated]').count()) === 12
		);
		// The seed and every keyed sidecar were consumed: their text is gone from the DOM.
		const leftover = await page.evaluate(() => {
			const seed = document.querySelector('script[type="application/ogygia-page"]');
			const sidecars = [...document.querySelectorAll('ogygia-region[wake="load"][data-hydrated][data-og-fp]')]
				.map((r) => document.getElementById('og-props-' + r.getAttribute('data-og-fp')) ??
					document.querySelector(`script[data-ogygia-props="${r.getAttribute('data-og-fp')}"]`))
				.filter((s): s is HTMLScriptElement => !!s);
			return {
				seed: seed?.textContent?.length ?? 0,
				sidecars: sidecars.map((s) => s.textContent?.length ?? 0)
			};
		});
		check('the seed text is blanked after its single parse', leftover.seed === 0, String(leftover.seed));
		check(
			'every hydrated load island released its keyed sidecar text',
			leftover.sidecars.length > 0 && leftover.sidecars.every((n) => n === 0),
			leftover.sidecars.join(',')
		);
		// The header island (300 KB props outside the seed) is live.
		await page.locator('[data-bench-header] nav button').first().click();
		check('header island interactive after boot', (await page.locator('[data-bench-header] ul li').count()) > 0);
	});
});
