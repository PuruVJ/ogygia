// After an in-app navigation the beacon's visit holds both pages on one clock: the Page tab cuts
// its report to what happened since the navigation, shifted to start there.
import { describe, it, expect } from 'vitest';
import { since_nav } from '../src/devtools/page.js';
import { analyze_page } from '../src/devtools/page-insights.js';
import type { BeaconPage } from '../src/runtime/beacon.js';

const page: BeaconPage = {
	vitals: { lcp: 5000, fcp: 400, ttfb: 90 },
	visit: { paints: { lcp: 5000 }, nav: { load: 300 }, resources: [] },
	islands: [
		{ fp: 'old', t0: 50, loaded: 60, done: 70 },
		{ fp: 'new', t0: 2100, loaded: 2120, turn: 2121, done: 2200 }
	],
	firsts: [{ fp: 'old', t: 40, type: 'pointer' }],
	shifts: [
		{ t: 65, value: 0.3, fp: 'old' },
		{ t: 2205, value: 0.05, fp: 'new' }
	],
	longtasks: [{ t: 2121, ms: 79 }],
	marks: [],
	snapshots: [],
	cpu: { state: 'off', traces: [] }
};

describe('since_nav', () => {
	const input = since_nav(page, 2000);
	it('keeps only this page\'s events, shifted to the navigation', () => {
		expect(input.islands.map((i) => i.fp)).toEqual(['new']);
		expect(input.islands[0]).toMatchObject({ t0: 100, loaded: 120, turn: 121, done: 200 });
		expect(input.firsts).toEqual([]);
		expect(input.shifts).toEqual([{ t: 205, value: 0.05, fp: 'new' }]);
		expect(input.longtasks).toEqual([{ t: 121, ms: 79 }]);
	});
	it('no finding leans on the first page\'s paints or vitals', () => {
		const r = analyze_page(input, [{ fp: 'new', name: 'New', kind: 'island', wake: 'load', hydrated: true, top: 10 }], [], 5000);
		const codes = r.findings.map((f) => f.code);
		expect(codes).not.toContain('vital-lcp');
		expect(codes).not.toContain('late-interactive');
		expect(codes).not.toContain('early-click'); // the old page's click
		expect(codes).toContain('long-hydrate'); // this page's own 79 ms hydrate
		expect(r.vitals).toEqual([]);
	});
});
