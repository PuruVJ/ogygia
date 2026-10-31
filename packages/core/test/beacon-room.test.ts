// A full list of the visit makes room for the page in view (runtime/beacon.ts `make_room`): after
// the document's first in-app navigation, the oldest of the LATER pages' entries goes — never the
// first page's (the profiler's report is about that one). One 320-island page once left every
// later page with no islands at all, and the Page tab found nothing there.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const g = globalThis as Record<string, unknown>;
beforeEach(() => {
	vi.useFakeTimers();
	g.document = {
		querySelector: (s: string) => (s.includes('ogygia-profiler-beacon') ? { getAttribute: () => '/__profiler/beacon' } : null),
		querySelectorAll: () => [],
		addEventListener: () => {},
		visibilityState: 'visible',
		cookie: ''
	};
	g.addEventListener = () => {};
});
afterEach(() => {
	vi.useRealTimers();
	delete g.document;
	delete g.addEventListener;
});

const island = (fp: string) => ({ getAttribute: (n: string) => (n === 'data-og-fp' ? fp : n === 'entry' ? 'x.js' : null), hasAttribute: () => false, innerHTML: '' }) as unknown as Element;

test('the page in view gets room; the first page keeps all of its own', async () => {
	const b = await import('../src/runtime/beacon.ts');
	b._reset_beacon();
	for (let i = 0; i < 10; i++) b.beacon_hydrated(island(`first${i}`), 1, 2, 3);
	b.beacon_nav({ from: '/a', to: '/b', type: 'link', t: 100, fetched: 110, styled: 120, swapped: 130 });
	for (let i = 0; i < 390; i++) b.beacon_hydrated(island(`busy${i}`), 200, 201, 202);
	// full (400): the next page's island still lands, in place of the oldest later one
	b.beacon_hydrated(island('now'), 500, 501, 502);
	const fps = b.beacon_page()!.islands.map((i) => i.fp);
	expect(fps).toHaveLength(400);
	expect(fps.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `first${i}`));
	expect(fps.at(-1)).toBe('now');
	expect(fps).not.toContain('busy0');
	b._reset_beacon();
});

test('before any navigation a full list keeps the first ones (the profiler’s page)', async () => {
	const b = await import('../src/runtime/beacon.ts');
	b._reset_beacon();
	for (let i = 0; i < 400; i++) b.beacon_hydrated(island(`first${i}`), 1, 2, 3);
	b.beacon_hydrated(island('late'), 500, 501, 502);
	const fps = b.beacon_page()!.islands.map((i) => i.fp);
	expect(fps).toHaveLength(400);
	expect(fps).not.toContain('late');
	b._reset_beacon();
});
