// Two copies of the beacon on one page (two apps' runtimes, or an island's `ogygia/profiler/client`
// from another build of the package than the runtime's) must not both watch the page: two CPU
// samplers split the browser's samples, and every visit reached the server twice. The first copy
// called owns the page; the other hands its calls over.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type Beacon = typeof import('../src/runtime/beacon.ts');

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

test('the second copy hands its marks and hydrations to the first', async () => {
	// @ts-expect-error a query makes a second module instance
	const a: Beacon = await import('../src/runtime/beacon.ts?copy=a');
	// @ts-expect-error a query makes a second module instance
	const b: Beacon = await import('../src/runtime/beacon.ts?copy=b');
	a._reset_beacon();
	b._reset_beacon();

	a.beacon_mark('boot', 1);
	b.beacon_mark('island work', 2);
	expect(a._beacon_state().marks).toBe(2);
	expect(b._beacon_state().marks).toBe(0);
	expect(b._beacon_state().scheduled).toBe(false); // never watched the page itself

	const el = { getAttribute: (n: string) => (n === 'data-og-fp' ? 'fp1' : n === 'entry' ? 'x.js' : null), hasAttribute: () => false, innerHTML: '' };
	b.beacon_hydrated(el as unknown as Element, 0, 1, 2);
	expect(a._beacon_state().queued).toBe(1);
	expect(b.beacon_page()?.islands.map((i) => i.fp)).toEqual(['fp1']); // read through the owner too

	a._reset_beacon();
	expect(g[Symbol.for('ogygia.beacon') as unknown as string]).toBeUndefined();
});

test("ogygia/profiler/client carries no beacon of its own: its marks reach the page's, and an early one waits for it", async () => {
	const key = Symbol.for('ogygia.beacon');
	const store = globalThis as Record<symbol, unknown>;
	const got: unknown[][] = [];
	// @ts-expect-error a query makes a fresh module instance
	const { mark } = await import('../src/profiler/client.ts?fresh=1');
	delete store[key];
	// before any runtime: held
	mark.start('early').end();
	expect(got).toEqual([]);
	// the page's beacon arrives: the held mark goes to it on the next retry, a new one at once
	store[key] = { beacon_mark: (...a: unknown[]) => got.push(a) };
	await vi.advanceTimersByTimeAsync(300);
	expect(got.map((a) => a[0])).toEqual(['early']);
	mark.start('late').end();
	expect(got.map((a) => a[0])).toEqual(['early', 'late']);
	delete store[key];
});
