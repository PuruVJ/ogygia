// THE HYDRATION SCHEDULER (runtime/schedule.ts), in a real browser: 21 expensive `wake:'load'`
// islands must hydrate ONE PER TASK — no long task of ogygia's making — and the ones intersecting
// the viewport must hydrate before the ones below the fold, whatever the document order says.
//
// The fixture (setup.ts) puts the 18 below-the-fold islands FIRST in document order and the 3
// in-viewport ones LAST, so viewport-first and document-first disagree. Each island spins ~6 ms at
// init (Heavy.svelte): the old back-to-back microtask hydration made one ~126 ms task of them.
import { expect, inject, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';
import { schedule_idle } from '../../src/runtime/schedule.js';

const inject_html = (key: 'heavy_schedule_ssr_b64') =>
	decodeURIComponent(escape(atob(inject(key))));

test('21 load islands: no task ≥ 50 ms, viewport islands first, then document order', async () => {
	// Warm the module graph first (Svelte's runtime, the fixture, the hydrate core) so the measured
	// tasks are hydration itself, not a first-import evaluation.
	await Promise.all([
		import('/test/browser/fixtures/Heavy.svelte'),
		import('../../src/runtime/hydrate-core.js')
	]);
	document.body.innerHTML = inject_html('heavy_schedule_ssr_b64');
	expect(document.querySelectorAll('ogygia-region').length).toBe(21);

	const order: number[] = [];
	document.addEventListener('ogygia:hydrated', (e) => {
		const n = (e.target as Element).querySelector('[data-heavy]')?.getAttribute('data-heavy');
		order.push(Number(n));
	});
	const long_tasks: number[] = [];
	const po = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) long_tasks.push(Math.round(entry.duration));
	});
	po.observe({ type: 'longtask' });

	bootDev();
	await expect.poll(() => order.length, { timeout: 20_000 }).toBe(21);
	// let the observer deliver anything still buffered, then read
	await new Promise((r) => setTimeout(r, 200));
	po.disconnect();

	expect(long_tasks, `long tasks (ms): ${long_tasks.join(', ')}`).toEqual([]);
	// The three islands that intersect the viewport (document order 18, 19, 20) hydrate FIRST —
	// their modules land in network order, staggered one task each, and a ready island below the
	// fold holds its turn while one of them is still loading.
	expect(
		[...order.slice(0, 3)].sort((a, b) => a - b),
		`order: ${order.join(', ')}`
	).toEqual([18, 19, 20]);
	expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 21 }, (_, i) => i));
	expect(schedule_idle()).toBe(true);
	expect(document.querySelectorAll('ogygia-region[data-hydrated]').length).toBe(21);
});
