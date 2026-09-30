/**
 * SINCE YOUR LAST PROFILE, THE VITALS (profiler/compare.ts `vitals_moved`): which vitals moved past
 * the noise, and for a split vital which of its parts moved most — the parts are the same splits the
 * explanations word (page-insights `vital_parts`).
 */
import { describe, it, expect } from 'vitest';
import { vitals_moved } from '../src/profiler/compare.js';
import { analyze_page, vital_parts, type PageInput } from '../src/devtools/page-insights.js';

const lcp_page = (download_end: number, lcp: number): PageInput => ({
	vitals: { lcp },
	visit: { nav: { res_start: 120 }, paints: { lcp, lcp_url: 'https://a.test/hero.png', lcp_tag: 'img' }, resources: [{ url: 'https://a.test/hero.png', type: 'img', start: 150, req_start: 160, end: download_end }] },
	islands: [],
	firsts: [],
	shifts: [],
	longtasks: []
});

describe('vitals_moved', () => {
	it('LCP grew: the part that grew is named (its download)', () => {
		const a = lcp_page(450, 500);
		const b = lcp_page(2950, 3000);
		const moved = vitals_moved(a.vitals, b.vitals, (side, key) => vital_parts(side === 'a' ? a : b, key));
		expect(moved).toEqual([{ key: 'lcp', a: 500, b: 3000, part: { label: 'its download', a: 290, b: 2790 } }]);
	});
	it('the noise floor: per vital (TTFB 50, FCP/LCP 100, INP 40 ms) and a fifth of the old value; CLS 0.05; a missing side says nothing', () => {
		const none = () => null;
		expect(vitals_moved({ lcp: 2000, ttfb: 300, cls: 0.1, inp: 180 }, { lcp: 2300, ttfb: 350, cls: 0.12, inp: 150 }, none)).toEqual([]);
		expect(vitals_moved({ ttfb: 100 }, { ttfb: 160 }, none)).toEqual([{ key: 'ttfb', a: 100, b: 160 }]);
		expect(vitals_moved({ cls: 0.02, inp: 120 }, { cls: 0.2, inp: 400 }, none)).toEqual([
			{ key: 'cls', a: 0.02, b: 0.2 },
			{ key: 'inp', a: 120, b: 400 }
		]);
		expect(vitals_moved({ lcp: 900 }, {}, none)).toEqual([]);
	});
	it('INP: the phase that grew is named (its handlers)', () => {
		const inp = (processing: number): PageInput => ({ ...lcp_page(450, 500), vitals: { inp: 30 + processing + 16 }, visit: { interaction: { t: 900, ms: 30 + processing + 16, name: 'click', delay: 30, processing, presentation: 16 } } as PageInput['visit'] });
		const a = inp(40);
		const b = inp(400);
		const moved = vitals_moved(a.vitals, b.vitals, (side, key) => vital_parts(side === 'a' ? a : b, key));
		expect(moved).toEqual([{ key: 'inp', a: 86, b: 446, part: { label: 'its handlers', a: 40, b: 400 } }]);
	});
	it('the parts are the explanation’s own numbers (one split, never two that drift)', () => {
		const p = lcp_page(2950, 3000);
		const parts = vital_parts(p, 'lcp')!;
		const message = analyze_page(p, [], [], 9000).findings.find((f) => f.code === 'slow-lcp')!.message;
		for (const x of parts) expect(message).toContain(`${Math.round(x.ms)} ms`);
		expect(parts.map((x) => x.key)).toEqual(['ttfb', 'delay', 'load', 'render']);
	});
});
