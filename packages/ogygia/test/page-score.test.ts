// The ogygia page score: one 0–100 number for a page, scored on what ogygia is for (least JS, clean
// hydration, small seed + server render, stable layout). Pure and inputs-only — this pins the curves,
// the renormalization when a category has no data, and the "fix this first" pick.
import { describe, test, expect } from 'vitest';
import { page_score, type ScoreInputs } from '../src/profiler/score.js';

const clean: ScoreInputs = {
	islandJsBytes: 12 * 1024,
	recovered: 0,
	neverWoke: 0,
	seedBytes: 6 * 1024,
	serverMs: 8,
	vitals: { lcp: 1800, cls: 0.02, inp: 120 }
};

describe('page_score', () => {
	test('a lean, clean page scores an A near 100', () => {
		const s = page_score(clean);
		expect(s.score).toBeGreaterThanOrEqual(95);
		expect(s.grade).toBe('A');
		expect(s.worst).toBeNull(); // nothing to fix
		expect(s.categories.map((c) => c.key).sort()).toEqual(['hydration', 'js', 'layout', 'seed', 'server']);
	});

	test('a recovered island is a correctness fault that tanks the hydration category and the total', () => {
		const s = page_score({ ...clean, recovered: 2 });
		const hyd = s.categories.find((c) => c.key === 'hydration')!;
		expect(hyd.score).toBe(100 - 2 * 34); // 32
		expect(s.score).toBeLessThan(page_score(clean).score);
		// with everything else perfect, hydration is the biggest loss → the thing to fix first
		expect(s.worst?.key).toBe('hydration');
	});

	test('heavy island JS is the dominant category and drags the score', () => {
		const s = page_score({ ...clean, islandJsBytes: 400 * 1024 });
		expect(s.categories.find((c) => c.key === 'js')!.score).toBe(0);
		expect(s.worst?.key).toBe('js'); // 30% weight × full gap
		expect(s.grade).not.toBe('A');
	});

	test('a missing category (no vitals, no server timing) renormalizes instead of costing points', () => {
		const withData = page_score(clean).score;
		const noExtras = page_score({ ...clean, serverMs: null, vitals: null });
		// still only the categories that had data, and a lean clean page is still ~100
		expect(noExtras.categories.map((c) => c.key).sort()).toEqual(['hydration', 'js', 'seed']);
		expect(noExtras.score).toBeGreaterThanOrEqual(95);
		expect(Math.abs(noExtras.score - withData)).toBeLessThanOrEqual(5);
	});

	test('vitals present but partial (only CLS) still scores layout, over what exists', () => {
		const s = page_score({ ...clean, vitals: { lcp: null, cls: 0.3, inp: null } });
		const layout = s.categories.find((c) => c.key === 'layout')!;
		expect(layout.score).toBe(0); // CLS 0.3 ≥ 0.25 worst
		expect(layout.value).toBe('CLS 0.3');
	});

	test('every sub-score is 0–100 and the grade bands hold', () => {
		const worst = page_score({
			islandJsBytes: 2_000_000,
			recovered: 9,
			neverWoke: 9,
			seedBytes: 2_000_000,
			serverMs: 5000,
			vitals: { lcp: 20000, cls: 2, inp: 3000 }
		});
		for (const c of worst.categories) expect(c.score).toBeGreaterThanOrEqual(0), expect(c.score).toBeLessThanOrEqual(100);
		expect(worst.score).toBeLessThan(40);
		expect(worst.grade).toBe('F');
	});
});
