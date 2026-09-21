// THE BROWSER STORE (profiler/ui/store.ts) in a real browser: a report's dump is kept and listed,
// the newest MAX stay, a page's visits come back newest first, and everything is best-effort.
import { expect, test } from 'vitest';
import { put_report, get_report, list_reports, delete_report, list_visits, latest_visit, clear_all } from '../../src/profiler/ui/store.js';

const dump = (id: string, page: string, created: number, runs: number[] = [10, 20, 30]) => ({ kind: 'ogygia-profiler-dump', version: 1, meta: { id, page, created, trigger: 'page', runs }, analysis: { busy_ms: 1 }, extras: {} });

test('reports: put, get, list newest first with the median, delete, and a cap on how many stay', async () => {
	await clear_all();
	expect(await put_report(dump('r1', '/a', 1000))).toBe(true);
	expect(await put_report(dump('r2', '/a', 2000, [5, 7, 9]))).toBe(true);
	expect(await put_report({ kind: 'ogygia-profiler-dump', version: 1, meta: { id: 'r3', created: 3000, trigger: 'request', request: { path: '/req' } }, analysis: {}, extras: {} })).toBe(true);
	const list = await list_reports();
	expect(list.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
	expect(list[1]).toMatchObject({ page: '/a', median: 7, trigger: 'page', label: '/a' });
	expect(list[0]).toMatchObject({ page: '/req', median: null, label: '/req' });
	expect((list[0] as { dump?: unknown }).dump).toBeUndefined();
	const got = await get_report('r2');
	expect((got!.dump as { meta: { id: string } }).meta.id).toBe('r2');
	await delete_report('r2');
	expect((await list_reports()).map((r) => r.id)).toEqual(['r3', 'r1']);
	expect(await get_report('nope')).toBeNull();
	// the cap: 45 puts keep the newest 40
	for (let i = 0; i < 45; i++) await put_report(dump(`c${i}`, '/c', 10_000 + i));
	const capped = await list_reports();
	expect(capped.length).toBe(40);
	expect(capped[0].id).toBe('c44');
	expect(capped.some((r) => r.id === 'r1')).toBe(false);
	await clear_all();
	expect(await list_reports()).toEqual([]);
});

test('visits: a page’s visits newest first, and the latest one', async () => {
	await clear_all();
	// the beacon writes visits with this shape (runtime/beacon.ts)
	const write = (key: string, page: string, at: number) =>
		new Promise<void>((resolve) => {
			const req = indexedDB.open('ogygia-profiler', 1);
			req.onsuccess = () => {
				const tx = req.result.transaction('visits', 'readwrite');
				tx.objectStore('visits').put({ key, page, at, visit: { at, nav: { req_start: 0, res_start: 10, res_end: 20 } }, snapshots: [] });
				tx.oncomplete = () => resolve();
				tx.onerror = () => resolve();
			};
			req.onerror = () => resolve();
		});
	await write('/p|1', '/p', 1);
	await write('/p|2', '/p', 2);
	await write('/q|3', '/q', 3);
	expect((await list_visits('/p')).map((v) => v.at)).toEqual([2, 1]);
	expect((await latest_visit('/p'))!.at).toBe(2);
	expect(await latest_visit('/nope')).toBeNull();
	await clear_all();
});
