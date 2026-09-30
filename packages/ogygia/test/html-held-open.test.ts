/**
 * THE DOCUMENT HELD OPEN (page-insights `explain_held_open`, profiler `stream_tail`): a load's
 * streamed promise keeps the response open, and islands wake only after the document's end — every
 * island waits. The seed names each streamed id by its page.data key; the server's chunks split
 * the early part from the late tail; the browser's first/last byte and the islands' hydrate steps
 * say who waited. The same finding from either side.
 */
import { describe, expect, it } from 'vitest';
import { stringify } from 'devalue';
import { stage_deferred, defer_reducer, resolve_script } from '../src/server/page-stream.js';
import { PAGE_DEFER_GLOBAL, PAGE_DEFER_KEY } from '../src/page-defer.js';
import { analyze_page, defer_keys, explain_held_open, type PageInput } from '../src/devtools/page-insights.js';
import { byte_strip } from '../src/profiler/byte-strip.js';
import { stream_tail } from '../src/profiler/stream-tail.js';

const never = new Promise(() => {});
const staged = stage_deferred({ title: 'lab', reviews: never, more: { stock: never } }, 0).staged;
const seed = stringify({ url: 'http://a.test/lab', data: staged }, defer_reducer);

describe('defer_keys', () => {
	it('names each streamed id by its page.data key (one level down too), from the document or the seed alone', () => {
		const doc = `<html><body><script type="application/ogygia-page" data-ogygia-page>${seed}</script></body></html>`;
		const want = new Map([
			[0, 'reviews'],
			[1, 'more.stock']
		]);
		expect(defer_keys(doc, PAGE_DEFER_KEY)).toEqual(want);
		expect(defer_keys(seed, PAGE_DEFER_KEY)).toEqual(want);
		expect(defer_keys('<html>no seed</html>')).toEqual(new Map());
		expect(defer_keys('<script type="application/ogygia-page">{not json</script>')).toEqual(new Map());
	});
});

describe('stream_tail', () => {
	it('splits at the longest pause and names what settled in the tail', () => {
		const head = `<html><body><h1>lab</h1><script type="application/ogygia-page" data-ogygia-page>${seed}</script></body></html>`;
		const r1 = resolve_script(PAGE_DEFER_GLOBAL, 1, { ok: true, value: 3 });
		const r0 = resolve_script(PAGE_DEFER_GLOBAL, 0, { ok: true, value: ['good'] });
		const html = head + r1 + r0;
		const chunks = [
			{ end: head.length, t: 4 },
			{ end: head.length + r1.length, t: 300 },
			{ end: html.length, t: 1200 }
		];
		const tail = stream_tail(html, byte_strip(html), chunks)!;
		expect(tail.early_ms).toBe(300);
		expect(tail.late_ms).toBe(1200);
		expect(tail.late_bytes).toBe(r0.length);
		expect(tail.keys).toEqual([{ key: 'reviews', id: 0, left_ms: 1200 }]);
		// (no long pause: nothing held)
		expect(stream_tail(html, byte_strip(html), [{ end: head.length, t: 4 }, { end: html.length, t: 60 }])).toBeNull();
	});
});

const page = (over: { res_end: number; fcp?: number; hydrate_at?: number; size?: number }): PageInput => {
	const hydrate_at = over.hydrate_at ?? over.res_end + 30;
	return {
		vitals: {},
		visit: { nav: { res_start: 6, res_end: over.res_end, dcl: over.res_end + 5, ...(over.size ? { size: over.size } : {}) }, paints: { fcp: over.fcp ?? 25 } },
		islands: [
			// (their scheduler turn came at the start gate: the document's end)
			{ fp: 'aaaa', t0: 30, loaded: 60, turn: hydrate_at, done: hydrate_at + 4 },
			{ fp: 'bbbb', t0: 30, loaded: 60, turn: hydrate_at + 4, done: hydrate_at + 10 }
		],
		firsts: [],
		shifts: [],
		longtasks: []
	};
};
const regions = [
	{ fp: 'aaaa', name: 'Reviews', kind: 'island' as const, wake: 'load', hydrated: true },
	{ fp: 'bbbb', name: 'Healthy', kind: 'island' as const, wake: 'load', hydrated: true }
];
const held = (p: PageInput) => analyze_page(p, regions).findings.find((f) => f.code === 'html-held-open');

describe('explain_held_open', () => {
	it('the browser: painted early, the HTML kept coming, every island hydrated after its end — named with the key that held it', () => {
		const f = held({ ...page({ res_end: 1207 }), held_open: { side: 'browser', keys: [{ key: 'title', at: 40 }, { key: 'reviews', at: 1207 }] } })!;
		expect(f.severity).toBe('warn');
		expect(f.message).toContain('kept coming until 1207 ms');
		expect(f.message).toContain('held by `page.data.reviews`');
		expect(f.message).not.toContain('page.data.title');
		expect(f.message).toContain('Reviews, Healthy');
		expect(f.fix).toContain("render: 'deferred'");
		expect(f.fps).toEqual(['aaaa', 'bbbb']);
	});
	it('decoys: a short stream, a paint that came with the end, islands that hydrated before the end', () => {
		expect(held(page({ res_end: 120 }))).toBeUndefined();
		expect(held(page({ res_end: 1200, fcp: 1150 }))).toBeUndefined();
		expect(held(page({ res_end: 1200, hydrate_at: 500 }))).toBeUndefined();
	});
	it('nothing known of the stream: a large HTML is its download; else say what usually holds it', () => {
		expect(held(page({ res_end: 1200, size: 900_000 }))!.fix).toContain('The HTML itself is large');
		expect(held(page({ res_end: 1200 }))!.fix).toContain('Something kept the response open');
	});
	it('the server alone (no visit): the tail left long after the rest, held by a key', () => {
		const f = explain_held_open({ vitals: {}, visit: null, islands: [], firsts: [], shifts: [], longtasks: [], held_open: { side: 'server', keys: [{ key: 'reviews', at: 1201 }], early_ms: 4, early_bytes: 10240, late_ms: 1201, late_bytes: 74, islands: 2 } }, [], (fp) => fp)!;
		expect(f.message).toContain('stayed open until 1201 ms, held by `page.data.reviews`');
		expect(f.message).toContain("the page's 2 islands wait 1197 ms longer");
		// (a page without islands: nothing waits)
		expect(explain_held_open({ vitals: {}, visit: null, islands: [], firsts: [], shifts: [], longtasks: [], held_open: { side: 'server', keys: [{ key: 'reviews', at: 1201 }], early_ms: 4, late_ms: 1201, islands: 0 } }, [], (fp) => fp)).toBeNull();
	});
});
