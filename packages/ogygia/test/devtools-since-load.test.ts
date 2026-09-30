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
