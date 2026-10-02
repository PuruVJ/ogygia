// Since your last load: findings fixed and new (by code and island), islands and vitals that moved
// past the noise floor, and nothing for another page.
import { expect, test } from 'vitest';
import { since_load, type LoadSnapshot } from '../src/devtools/since-load.js';

const snap = (over: Partial<LoadSnapshot> = {}): LoadSnapshot => ({
	path: '/lab',
	at: 1000,
	findings: [],
	islands: [],
	vitals: [],
	...over
});

test('fixed, new, and what moved', () => {
	const prev = snap({
		findings: [{ code: 'long-hydrate', names: ['Heavy'] }, { code: 'markup-changed', names: ['Clock'] }],
		islands: [{ name: 'Heavy', load_ms: 10, hydrate_ms: 140 }, { name: 'Healthy', load_ms: 10, hydrate_ms: 4 }],
		vitals: [{ key: 'lcp', value: 900 }, { key: 'cls', value: 0.2 }, { key: 'ttfb', value: 20 }]
	});
	const now = snap({
		at: 6000,
		findings: [{ code: 'markup-changed', names: ['Clock'] }, { code: 'early-click', names: ['Menu'] }],
		islands: [{ name: 'Heavy', load_ms: 10, hydrate_ms: 5 }, { name: 'Healthy', load_ms: 10, hydrate_ms: 9 }],
		vitals: [{ key: 'lcp', value: 400 }, { key: 'cls', value: 0.19 }, { key: 'ttfb', value: 35 }]
	});
	const s = since_load(prev, now, 6000)!;
	expect(s.ago_ms).toBe(5000);
	expect(s.fixed).toEqual(['long-hydrate (Heavy)']);
	expect(s.added).toEqual(['early-click (Menu)']);
	// Heavy 140 → 5 and LCP 900 → 400 moved; Healthy +5 ms, CLS −0.01 and TTFB +15 ms are noise
	expect(s.moved.map((m) => m.what).sort()).toEqual(['Heavy hydrate', 'LCP']);
	expect(s.moved.every((m) => m.better)).toBe(true);
});

test('a moved vital names its part that moved most (the shared rule); a module load needs 50 ms', () => {
	const parts = (load: number) => ({ lcp: [{ key: 'ttfb', label: 'the first byte', ms: 100 }, { key: 'load', label: 'its download', ms: load }] });
	const prev = snap({ vitals: [{ key: 'lcp', value: 2900 }], parts: parts(2700), islands: [{ name: 'Hero', load_ms: 60, hydrate_ms: 3 }, { name: 'Big', load_ms: 100, hydrate_ms: 3 }] });
	const now = snap({ vitals: [{ key: 'lcp', value: 500 }], parts: parts(300), islands: [{ name: 'Hero', load_ms: 90, hydrate_ms: 3 }, { name: 'Big', load_ms: 400, hydrate_ms: 3 }] });
	const s = since_load(prev, now)!;
	expect(s.moved).toEqual([
		{ what: 'LCP', a: 2900, b: 500, unit: 'ms', better: true, part: { label: 'its download', a: 2700, b: 300 } },
		{ what: 'Big load', a: 100, b: 400, unit: 'ms', better: false }
	].sort((x, y) => Math.abs(y.b - y.a) / y.a - Math.abs(x.b - x.a) / x.a));
	// (an older picture without parts: the vital, no part)
	expect(since_load({ ...prev, parts: undefined }, now)!.moved.find((m) => m.what === 'LCP')!.part).toBeUndefined();
});

test('the same finding on another island is a new one; another page compares to nothing', () => {
	const prev = snap({ findings: [{ code: 'long-hydrate', names: ['Heavy'] }] });
	const now = snap({ findings: [{ code: 'long-hydrate', names: ['Other'] }] });
	const s = since_load(prev, now)!;
	expect(s.fixed).toEqual(['long-hydrate (Heavy)']);
	expect(s.added).toEqual(['long-hydrate (Other)']);
	expect(since_load(prev, snap({ path: '/other' }))).toBeNull();
});

test('the last load was the dev server’s first compile: nothing "fixed" by the warm-up, loads compared without it', () => {
	// measured on /dt-lab: every island's load 776 ms on the cold load, 33 ms on the reload
	const prev = snap({
		findings: [{ code: 'late-interactive', names: ['Heavy'] }, { code: 'long-hydrate', names: ['Heavy'] }],
		islands: [{ name: 'Heavy', load_ms: 776, hydrate_ms: 140, compile_ms: 740 }, { name: 'Clock', load_ms: 776, hydrate_ms: 2, compile_ms: 740 }]
	});
	const now = snap({ islands: [{ name: 'Heavy', load_ms: 33, hydrate_ms: 5 }, { name: 'Clock', load_ms: 33, hydrate_ms: 2 }] });
	const s = since_load(prev, now)!;
	// the real fix still counts; the compile's own finding does not
	expect(s.fixed).toEqual(['long-hydrate (Heavy)']);
	expect(s.moved.map((m) => m.what)).toEqual(['Heavy hydrate']);
	expect(s.note).toContain('the dev server compiling this page');
	expect(s.note).toContain('one finding');
	// the PAGE compiled on the last load's request (a 3.9 s first byte): its first byte, paints and
	// their findings are not "fixed" either
	const page_prev = snap({
		page_compiled: true,
		findings: [{ code: 'slow-ttfb', names: [] }, { code: 'slow-lcp', names: ['Grower'] }, { code: 'long-hydrate', names: ['Heavy'] }],
		vitals: [{ key: 'ttfb', value: 3919 }, { key: 'lcp', value: 3936 }]
	});
	const page_now = snap({ vitals: [{ key: 'ttfb', value: 7 }, { key: 'lcp', value: 28 }] });
	const p = since_load(page_prev, page_now)!;
	expect(p.fixed).toEqual(['long-hydrate (Heavy)']);
	expect(p.moved).toEqual([]);
	expect(p.note).toContain("its first byte, its paints and its islands' loads are not compared");
	// (an island's load, cold under the page's compile: not compared)
	const cold_islands = since_load(snap({ page_compiled: true, islands: [{ name: 'Heavy', load_ms: 157, hydrate_ms: 5 }] }), snap({ islands: [{ name: 'Heavy', load_ms: 31, hydrate_ms: 5 }] }))!;
	expect(cold_islands.moved).toEqual([]);
	// a load that was not compiling: no note
	expect(since_load(snap({ islands: [{ name: 'Heavy', load_ms: 33, hydrate_ms: 5 }] }), now)?.note).toBeUndefined();
});
