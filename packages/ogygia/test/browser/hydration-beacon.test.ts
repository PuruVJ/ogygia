// THE HYDRATION BEACON (runtime/beacon.ts) in a real browser: with the profiler's meta tag in the
// document, an island that wakes reports `{ fp, entry, ms, load }` in ONE batched sendBeacon (on
// idle / pagehide), keyed by its server-minted fingerprint; an island with no fingerprint (a
// standalone render) and a page without the tag send nothing.
import { expect, inject, test } from 'vitest';
import { bootDev } from '../../src/runtime/full.js';
import { _reset_beacon, _beacon_state } from '../../src/runtime/beacon.js';

const inject_html = (key: 'counter_json_lane_ssr_b64' | 'heavy_schedule_ssr_b64') =>
	decodeURIComponent(escape(atob(inject(key))));

test('a fingerprinted island reports its hydration timing to the profiler beacon, batched, by fingerprint', async () => {
	await Promise.all([import('/test/browser/fixtures/Counter.svelte'), import('../../src/runtime/hydrate-core.js')]);
	_reset_beacon();
	const meta = document.createElement('meta');
	meta.name = 'ogygia-profiler-beacon';
	meta.content = '/__profiler/beacon';
	document.head.appendChild(meta);
	const sent: { url: string; body: string }[] = [];
	const orig = navigator.sendBeacon;
	navigator.sendBeacon = ((url: string, body: string) => {
		sent.push({ url, body });
		return true;
	}) as typeof navigator.sendBeacon;
	try {
		// the page-pass shape: the region carries data-og-fp, its sidecar sits at the end of the body
		document.body.innerHTML = inject_html('counter_json_lane_ssr_b64');
		bootDev();
		await expect.poll(() => document.querySelector('ogygia-region[data-og-fp][data-hydrated]') !== null, { timeout: 20_000 }).toBe(true);
		expect(_beacon_state().target).toBe('/__profiler/beacon');
		// the batch goes out on idle (an idle browser fires it at once) or when the page hides —
		// force the latter; either way exactly one beacon leaves
		dispatchEvent(new Event('pagehide'));
		// two beacons: the islands batch, then the page's web vitals (final only when the page hides)
		const bodies = sent.map((s) => JSON.parse(s.body) as { page: string; islands?: unknown[]; vitals?: Record<string, number> });
		expect(sent.every((s) => s.url === '/__profiler/beacon')).toBe(true);
		const island_posts = bodies.filter((b) => b.islands);
		const vitals_posts = bodies.filter((b) => b.vitals);
		const visit_posts = bodies.filter((b) => (b as { visit?: unknown }).visit);
		expect(island_posts).toHaveLength(1);
		expect(vitals_posts).toHaveLength(1);
		// the VISIT: navigation timing, the islands with their wake times on the page's clock, the
		// viewport — posted early (first idle) and again, final, on hide; the server folds the two
		expect(visit_posts.length).toBeGreaterThanOrEqual(1);
		expect(visit_posts.length).toBeLessThanOrEqual(2);
		const visit = (visit_posts[visit_posts.length - 1] as { visit: { nav: { res_start: number }; islands: { fp: string; t0: number; done: number; ssr_bytes?: number }[]; viewport: number[]; resources: unknown[] } }).visit;
		expect(typeof visit.nav.res_start).toBe('number');
		expect(visit.islands).toHaveLength(1);
		expect(visit.islands[0].fp).toBe('0000aaaa1111bbbb');
		expect(visit.islands[0].done).toBeGreaterThanOrEqual(visit.islands[0].t0);
		expect(typeof visit.islands[0].ssr_bytes).toBe('number');
		expect(visit.viewport.length).toBe(2);
		// …and the same visit is kept in this browser's own store, where the profiler UI reads it back
		const kept = await new Promise<{ page: string; snapshots: unknown[] }[]>((resolve) => {
			const req = indexedDB.open('ogygia-profiler', 1);
			req.onsuccess = () => {
				const all = req.result.transaction('visits').objectStore('visits').getAll();
				all.onsuccess = () => resolve(all.result as { page: string; snapshots: unknown[] }[]);
				all.onerror = () => resolve([]);
			};
			req.onerror = () => resolve([]);
		});
		await expect.poll(async () => kept.some((k) => k.page === location.pathname) || (await new Promise<boolean>((resolve) => {
			const req = indexedDB.open('ogygia-profiler', 1);
			req.onsuccess = () => {
				const all = req.result.transaction('visits').objectStore('visits').getAll();
				all.onsuccess = () => resolve((all.result as { page: string }[]).some((k) => k.page === location.pathname));
				all.onerror = () => resolve(false);
			};
			req.onerror = () => resolve(false);
		})), { timeout: 5000 }).toBe(true);
		expect(vitals_posts[0].page).toBe(location.pathname);
		expect(typeof vitals_posts[0].vitals!.ttfb).toBe('number'); // navigation timing is always there
		const payload = island_posts[0] as { page: string; islands: { fp: string; entry: string; ms: number; load: number }[] };
		expect(payload.islands).toHaveLength(1);
		const [i] = payload.islands;
		expect(i.fp).toBe('0000aaaa1111bbbb');
		expect(i.entry).toContain('Counter.svelte');
		expect(i.ms).toBeGreaterThanOrEqual(0);
		expect(i.load).toBeGreaterThanOrEqual(0);
		expect(i.load).toBeLessThanOrEqual(i.ms);
		// the queue drained and the vitals went once: a second hide sends nothing
		const before = sent.length;
		dispatchEvent(new Event('pagehide'));
		expect(sent.length).toBe(before);
		expect(_beacon_state().queued).toBe(0);
	} finally {
		navigator.sendBeacon = orig;
		meta.remove();
	}
});

test('islands without a fingerprint (a standalone render) queue nothing', async () => {
	await Promise.all([import('/test/browser/fixtures/Heavy.svelte'), import('../../src/runtime/hydrate-core.js')]);
	_reset_beacon();
	const meta = document.createElement('meta');
	meta.name = 'ogygia-profiler-beacon';
	meta.content = '/__profiler/beacon';
	document.head.appendChild(meta);
	try {
		document.body.innerHTML = inject_html('heavy_schedule_ssr_b64');
		const total = document.querySelectorAll('ogygia-region').length;
		let hydrated = 0;
		document.addEventListener('ogygia:hydrated', () => hydrated++);
		bootDev();
		await expect.poll(() => hydrated, { timeout: 20_000 }).toBe(total);
		expect(_beacon_state()).toMatchObject({ target: '/__profiler/beacon', queued: 0 });
	} finally {
		meta.remove();
	}
});
