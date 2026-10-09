// The page score: one 0–100 number, scored on what a visitor pays for whatever built the page. Pure
// and inputs-only — this pins the curves, the "no measurement is never a free 100" rule, and the
// fairness case that started the rework: a page with NO islands that ships 6 MB of JS must score
// far below a lean islands page, not 100.
import { describe, test, expect } from 'vitest';
import { page_score, curve, CURVES, type ScoreInputs, type ScoreAssets } from '../src/profiler/score.js';

const KB = 1024;
const MB = 1024 * KB;

const lean_assets: ScoreAssets = {
	js: 40 * KB,
	js_wire: 14 * KB,
	js_files: 4,
	lazy_js: 20 * KB,
	css: 8 * KB,
	wire: 90 * KB,
	blocking: 6 * KB,
	blocking_count: 1
};

// a lean islands page: little JS, clean hydration, fast server, good vitals
const lean: ScoreInputs = {
	assets: lean_assets,
	htmlBytes: 40 * KB,
	hasIslands: true,
	browserSeen: true,
	recovered: 0,
	neverWoke: 0,
	dataBytes: 6 * KB,
	serverMs: 25,
	vitals: { lcp: 900, cls: 0.01, inp: 60, fcp: 600, ttfb: 120 },
	tbt: 0
};

// the same content as a fully hydrated page: no islands, a 6 MB start graph, inline page data
const heavy: ScoreInputs = {
	assets: { js: 6 * MB, js_wire: 1.6 * MB, js_files: 140, lazy_js: 0, css: 120 * KB, wire: 2.1 * MB, blocking: 120 * KB, blocking_count: 6 },
	htmlBytes: 180 * KB,
	hasIslands: false,
	browserSeen: true,
	recovered: 0,
	neverWoke: 0,
	dataBytes: 160 * KB,
	serverMs: 60,
	vitals: { lcp: 3200, cls: 0.02, inp: 280, fcp: 1400, ttfb: 150 },
	tbt: 900
};

describe('curve', () => {
	test('passes through its control points and never cliffs', () => {
		expect(curve(CURVES.js[0], CURVES.js[0], CURVES.js[1])).toBe(90);
		expect(curve(CURVES.js[1], CURVES.js[0], CURVES.js[1])).toBe(50);
		expect(curve(0, 100, 200)).toBe(100);
		// monotone: more is never better
		let prev = 101;
		for (let v = 10 * KB; v <= 8 * MB; v *= 1.5) {
			const s = curve(v, CURVES.js[0], CURVES.js[1]);
			expect(s).toBeLessThanOrEqual(prev);
			prev = s;
		}
		// twice the median still scores something, a tenth of p10 scores near 100
		expect(curve(2 * CURVES.js[1], CURVES.js[0], CURVES.js[1])).toBeGreaterThan(0);
		expect(curve(CURVES.js[0] / 10, CURVES.js[0], CURVES.js[1])).toBeGreaterThanOrEqual(99);
	});

	test('just under the p10 does not round into the green', () => {
		expect(curve(CURVES.js[0] * 1.01, CURVES.js[0], CURVES.js[1])).toBeLessThan(90);
	});
});

describe('page_score', () => {
	test('a lean islands page scores an A', () => {
		const s = page_score(lean);
		expect(s.score).toBeGreaterThanOrEqual(90);
		expect(s.grade).toBe('A');
		expect(s.missing).toEqual([]);
	});

	test('THE FAIRNESS CASE: 6 MB of JS with no islands scores far below the lean islands page', () => {
		const h = page_score(heavy);
		const l = page_score(lean);
		expect(h.score).toBeLessThan(l.score - 30);
		const js = h.categories.find((c) => c.key === 'js')!;
		expect(js.value).toContain('6.0 MB');
		expect(js.score).toBeLessThan(15);
		// no islands → hydration integrity is not a free 100; it is simply not scored
		expect(h.categories.some((c) => c.key === 'hydration')).toBe(false);
		expect(h.worst?.key).toBe('js');
	});

	test("a fast machine's clean visit does not wash out heavy JS", () => {
		const no_visit = page_score({ ...heavy, vitals: null, tbt: null });
		const fast_visit = page_score({ ...heavy, vitals: { lcp: 700, cls: 0, inp: 40, fcp: 500, ttfb: 60 }, tbt: 0 });
		// the visit adds good categories, but JS keeps its full weight: still well short of an A
		expect(fast_visit.score).toBeLessThan(90);
		expect(fast_visit.categories.find((c) => c.key === 'js')!.weight).toBe(no_visit.categories.find((c) => c.key === 'js')!.weight);
	});

	test('an unweighed page (dev server) leaves JS out, says why, and never reads 0 B', () => {
		const s = page_score({ ...lean, assets: null, assets_missing: 'the dev server serves modules one by one' });
		expect(s.categories.some((c) => c.key === 'js' || c.key === 'weight' || c.key === 'blocking')).toBe(false);
		expect(s.missing.find((m) => m.key === 'js')?.why).toContain('dev server');
	});

	test('no browser visit: vitals and integrity are left out, not scored 100', () => {
		const s = page_score({ ...lean, vitals: null, tbt: null, browserSeen: false });
		const keys = s.categories.map((c) => c.key);
		expect(keys).not.toContain('loading');
		expect(keys).not.toContain('hydration');
		expect(s.missing.map((m) => m.key).sort()).toEqual(['hydration', 'loading', 'responsiveness', 'stability']);
	});

	test('hydration faults are steep and ordered: recovered > never woke > changed', () => {
		const h = (x: Partial<ScoreInputs>) => page_score({ ...lean, ...x }).categories.find((c) => c.key === 'hydration')!.score;
		expect(h({ recovered: 1 })).toBeLessThan(h({ neverWoke: 1 }));
		expect(h({ neverWoke: 1 })).toBeLessThan(h({ changed: 1 }));
		expect(h({ changed: 1 })).toBeLessThan(100);
		expect(h({ recovered: 3 })).toBeLessThan(30);
	});

	test('every millisecond counts: a slower server always scores lower', () => {
		const at = (ms: number) => page_score({ ...lean, serverMs: ms }).score;
		expect(at(60)).toBeLessThan(at(30));
		expect(at(300)).toBeLessThan(at(150));
		expect(at(3000)).toBeLessThan(at(1000));
	});

	test('render-blocking counts requests too, not only bytes', () => {
		const one = page_score({ ...lean, assets: { ...lean_assets, blocking: 30 * KB, blocking_count: 1 } });
		const many = page_score({ ...lean, assets: { ...lean_assets, blocking: 30 * KB, blocking_count: 10 } });
		const b = (s: ReturnType<typeof page_score>) => s.categories.find((c) => c.key === 'blocking')!.score;
		expect(b(many)).toBeLessThan(b(one));
	});

	test('each category reports the points it cost, and the worst is the biggest loss', () => {
		const s = page_score(heavy);
		const total_lost = s.categories.reduce((x, c) => x + (c.lost ?? 0), 0);
		expect(Math.abs(100 - total_lost - s.score)).toBeLessThanOrEqual(1.5);
		for (const c of s.categories) expect(c.lost ?? 0).toBeLessThanOrEqual(s.worst!.lost!);
	});

	test('every sub-score is 0–100 and the grade bands hold', () => {
		const worst = page_score({
			assets: { js: 20 * MB, js_wire: 6 * MB, js_files: 900, lazy_js: 0, css: 2 * MB, wire: 30 * MB, blocking: 3 * MB, blocking_count: 40 },
			htmlBytes: 5 * MB,
			hasIslands: true,
			browserSeen: true,
			recovered: 9,
			neverWoke: 9,
			dataBytes: 4 * MB,
			serverMs: 5000,
			vitals: { lcp: 20000, cls: 2, inp: 3000, fcp: 9000, ttfb: 4000 },
			tbt: 9000
		});
		for (const c of worst.categories) {
			expect(c.score).toBeGreaterThanOrEqual(0);
			expect(c.score).toBeLessThanOrEqual(100);
		}
		expect(worst.grade).toBe('F');
		expect(worst.score).toBeLessThan(10);
	});

	test("a browser that cannot see long tasks or shifts: unknown, named — never a clean zero", () => {
		const why = 'the browser that visited does not report long tasks';
		// INP measured, blocking time not: scored on INP alone, and the missing part said
		const s = page_score({ ...lean, vitals: { lcp: 700, cls: null, inp: 40, fcp: 500, ttfb: 60 }, tbt: null, unmeasured: { tbt: why, cls: 'no shifts from Safari' } });
		const resp = s.categories.find((c) => c.key === 'responsiveness')!;
		expect(resp.value).toBe('INP 40 ms');
		expect(s.missing.find((m) => m.label.startsWith('Blocking time'))?.why).toBe(why);
		expect(s.categories.some((c) => c.key === 'stability')).toBe(false);
		expect(s.missing.find((m) => m.key === 'stability')?.why).toBe('no shifts from Safari');
	});
});

describe('what a visit fetched for nothing', () => {
	test('the page weight says it, and the score stays the weighed bytes', () => {
		const plain = page_score(lean);
		const with_waste = page_score({ ...lean, wasted: { bytes: 340 * KB, images: 336 * KB, preloads: 4 * KB } });
		const w = with_waste.categories.find((c) => c.key === 'weight')!;
		expect(w.note).toBe('Light on the wire. A visit fetched 340 KB for nothing: 336 KB of image pixels bigger than their boxes and 4 KB of preloads nothing used.');
		expect(with_waste.score).toBe(plain.score);
	});
});
