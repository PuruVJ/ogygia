import { describe, it, expect } from 'vitest';
import { analyze_page, first_difference, rate, type PageInput, type RegionFact } from '../src/devtools/page-insights.js';
import { without_comments } from '../src/runtime/beacon.js';

const region = (fp: string, name: string, wake = 'load', extra: Partial<RegionFact> = {}): RegionFact => ({
	fp,
	name,
	kind: 'island',
	wake,
	hydrated: true,
	top: 100,
	height: 40,
	...extra
});

const page = (over: Partial<PageInput> = {}): PageInput => ({
	vitals: {},
	visit: { nav: { res_start: 50, dcl: 200, load: 300 }, paints: { fcp: 150, lcp: 180 }, resources: [], viewport: [1280, 800] },
	islands: [],
	firsts: [],
	shifts: [],
	longtasks: [],
	...over
});

const codes = (r: ReturnType<typeof analyze_page>) => r.findings.map((f) => f.code);

describe('without_comments', () => {
	it('drops every comment and keeps the rest', () => {
		expect(without_comments('<!--[--><p>a<!---->b</p><!--]-->')).toBe('<p>ab</p>');
		expect(without_comments('plain')).toBe('plain');
		expect(without_comments('a<!-- open')).toBe('a');
	});
});

describe('first_difference', () => {
	it('ignores re-anchored block markers and finds the visible change', () => {
		expect(first_difference('<!--[0--><p>x</p><!--]-->', '<!--[--><!--[0--><p>x</p><!--]--><!--]-->')).toBeNull();
		const d = first_difference('<p>rendered on the server</p>', '<p>rendered on the browser</p>');
		expect(d?.server).toContain('server');
		expect(d?.now).toContain('browser');
	});
});

describe('rate', () => {
	it('uses the web-vitals lines', () => {
		expect(rate('lcp', 2400)).toBe('good');
		expect(rate('lcp', 3000)).toBe('fair');
		expect(rate('lcp', 4000)).toBe('poor');
		expect(rate('cls', 0.05)).toBe('good');
		expect(rate('cls', 0.3)).toBe('poor');
	});
});

describe('analyze_page', () => {
	it('a healthy page has no findings', () => {
		const r = analyze_page(
			page({
				vitals: { ttfb: 100, fcp: 150, lcp: 180, cls: 0 },
				islands: [{ fp: 'a', t0: 60, loaded: 80, turn: 82, done: 86 }]
			}),
			[region('a', 'Healthy')],
			[],
			500
		);
		expect(r.findings).toEqual([]);
		expect(r.rows[0]).toMatchObject({ name: 'Healthy', load_ms: 20, queue_ms: 2, hydrate_ms: 4 });
	});

	it('pins each measured problem on its island', () => {
		const r = analyze_page(
			page({
				islands: [
					{ fp: 'clock', t0: 60, loaded: 80, turn: 80, done: 84, changed: true },
					{ fp: 'grow', t0: 60, loaded: 80, turn: 84, done: 90 },
					{ fp: 'heavy', t0: 60, loaded: 80, turn: 90, done: 230 },
					{ fp: 'late', t0: 400, loaded: 420, turn: 420, done: 430 }
				],
				shifts: [{ t: 100, value: 0.12, fp: 'grow' }],
				firsts: [{ fp: 'late', t: 380, type: 'pointer' }],
				snapshots: [{ fp: 'clock', ssr: '<!--[--><p>on the server</p><!--]-->', hydrated: '<!--[--><!--[--><p>on the browser</p><!--]--><!--]-->' }]
			}),
			[region('clock', 'Clock'), region('grow', 'Grower'), region('heavy', 'Heavy'), region('late', 'LateClick', 'visible', { top: 2000 })],
			[{ fp: 'broken', message: 'boom' }],
			500
		);
		const by = Object.fromEntries(r.findings.map((f) => [f.code, f]));
		expect(by['hydrate-failed'].severity).toBe('error');
		expect(by['markup-changed'].fps).toEqual(['clock']);
		expect(by['markup-changed'].message).toContain('"');
		expect(by['hydration-shift'].fps).toEqual(['grow']);
		expect(by['long-hydrate'].fps).toEqual(['heavy']);
		expect(by['early-click'].fps).toEqual(['late']);
		// errors first
		expect(r.findings[0].code).toBe('hydrate-failed');
	});

	it('an interaction island clicked before it woke is by design, not a lost click', () => {
		const r = analyze_page(
			page({ islands: [{ fp: 'ix', t0: 400, loaded: 420, done: 430 }], firsts: [{ fp: 'ix', t: 399, type: 'pointer' }] }),
			[region('ix', 'OnClick', 'interaction')],
			[],
			500
		);
		expect(codes(r)).not.toContain('early-click');
	});

	it('a click on an island that never woke counts too', () => {
		const r = analyze_page(page({ firsts: [{ fp: 'v', t: 250, type: 'pointer' }] }), [region('v', 'Sleepy', 'visible', { hydrated: false })], [], 500);
		expect(codes(r)).toContain('early-click');
	});

	it('eager islands below the fold, but not lazy ones', () => {
		const r = analyze_page(page(), [region('e', 'BelowEager', 'load', { top: 2000 }), region('l', 'BelowLazy', 'visible', { top: 2000 })], [], 500);
		const f = r.findings.find((x) => x.code === 'eager-offscreen');
		expect(f?.fps).toEqual(['e']);
	});

	it('held with nothing ahead: the scheduler’s own wait is named, and only that', () => {
		// the round-46 shape: woken by a scroll long after load, code in hand, 70 ms with nothing ahead
		const idle = analyze_page(page({ islands: [{ fp: 'v', t0: 1000, loaded: 1000, turn: 1070, done: 1071 }] }), [region('v', 'Scrolled', 'visible')], [], 2000);
		const f = idle.findings.find((x) => x.code === 'held-idle');
		expect(f?.fps).toEqual(['v']);
		expect(f?.message).toContain('Scrolled had its code but waited 70 ms');
		// a queue: another island hydrated through the whole wait
		const queue = analyze_page(
			page({ islands: [{ fp: 'h', t0: 1000, loaded: 1000, turn: 1000, done: 1068 }, { fp: 'q', t0: 1000, loaded: 1000, turn: 1070, done: 1071 }] }),
			[region('h', 'Heavy'), region('q', 'Victim')],
			[],
			2000
		);
		expect(codes(queue)).not.toContain('held-idle');
		// the start gate: woken before DOMContentLoaded and the first paint (220 ms here)
		const gate = analyze_page(page({ islands: [{ fp: 'g', t0: 60, loaded: 80, turn: 215, done: 216 }] }), [region('g', 'Early')], [], 2000);
		expect(codes(gate)).not.toContain('held-idle');
		// held on purpose: below the fold, while a first-screen island still loads its code
		const held = analyze_page(
			page({ islands: [{ fp: 'f', t0: 990, loaded: 1075, turn: 1075, done: 1076 }, { fp: 'b', t0: 1000, loaded: 1000, turn: 1078, done: 1079 }] }),
			[region('f', 'Top'), region('b', 'Below', 'load', { top: 2000 })],
			[],
			2000
		);
		expect(codes(held)).not.toContain('held-idle');
		// under the threshold: the snapshot's normal first report
		const short = analyze_page(page({ islands: [{ fp: 'v', t0: 1000, loaded: 1000, turn: 1030, done: 1031 }] }), [region('v', 'Quick', 'visible')], [], 2000);
		expect(codes(short)).not.toContain('held-idle');
	});

	it('a queued island names the islands that ran ahead of it', () => {
		const r = analyze_page(
			page({
				islands: [
					{ fp: 'h', t0: 60, loaded: 80, turn: 80, done: 220 },
					{ fp: 'q', t0: 60, loaded: 80, turn: 230, done: 232 }
				]
			}),
			[region('h', 'Heavy'), region('q', 'Victim')],
			[],
			500
		);
		const f = r.findings.find((x) => x.code === 'queued');
		expect(f?.fps).toEqual(['q']);
		expect(f?.message).toContain('behind Heavy');
	});

	it('a later success clears nothing it should not: a wake-at-load island asleep 3 s after load', () => {
		const r = analyze_page(page(), [region('s', 'Asleep', 'load', { hydrated: false })], [], 3400);
		expect(codes(r)).toContain('never-woke');
		const early = analyze_page(page(), [region('s', 'Asleep', 'load', { hydrated: false })], [], 1000);
		expect(codes(early)).not.toContain('never-woke');
	});

	it('blocking files matter only when they held the paint back', () => {
		const small = Array.from({ length: 9 }, (_, i) => ({ url: `/a${i}.css`, type: 'css', start: 60, end: 64, blocking: true }));
		expect(codes(analyze_page(page({ visit: { ...page().visit!, resources: small } }), [], [], 500))).not.toContain('render-blocking');
		const slow = [{ url: '/big.css', type: 'css', start: 60, end: 400, blocking: true }];
		expect(codes(analyze_page(page({ visit: { ...page().visit!, paints: { fcp: 420 }, resources: slow } }), [], [], 500))).toContain('render-blocking');
	});

	it('the largest paint in an island that changed on hydration', () => {
		const r = analyze_page(
			page({
				visit: { ...page().visit!, paints: { fcp: 150, lcp: 180, lcp_fp: 'hero', lcp_tag: 'h1' } },
				islands: [{ fp: 'hero', t0: 60, loaded: 80, done: 90, changed: true }]
			}),
			[region('hero', 'Hero')],
			[],
			500
		);
		expect(codes(r)).toContain('lcp-repaint');
	});

	it('long tasks outside hydration are the page scripts', () => {
		const r = analyze_page(
			page({ islands: [{ fp: 'a', t0: 60, loaded: 80, done: 90 }], longtasks: [{ t: 700, ms: 220 }] }),
			[region('a', 'A')],
			[],
			1500
		);
		expect(codes(r)).toContain('long-tasks');
		expect(r.longtask_ms).toBe(220);
	});
});
