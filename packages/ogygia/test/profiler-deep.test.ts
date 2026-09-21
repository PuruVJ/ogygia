/**
 * The deep pictures, pure parts: the byte strip of a document, a visit parsed and laid out on one
 * clock with the server, the data river (what a load returns, the seed's bytes per key, the flow),
 * the DOM diff and shift boxes, and the sink's rows and aggregations.
 */
import { describe, expect, it } from 'vitest';
import { byte_strip, arrival_ms } from '../src/profiler/byte-strip.js';
import { parse_visit, one_clock, merge_visits, type Visit } from '../src/profiler/visit.js';
import { build_river, load_return_keys, seed_key_bytes } from '../src/profiler/river.js';
import { html_diff, tokenize_html, shift_boxes } from '../src/profiler/dom-diff.js';
import { SinkBuffer, parse_sink, cloud_points, layer_cake, hot_for_range, type SinkRow } from '../src/profiler/sink.js';
import { heap_sites, slice_delta, attribute_gc, gc_kind } from '../src/profiler/gc.js';
import { analyze } from '../src/profiler/analyze.js';
import { sync_io, memo_candidates, simulate_awaits } from '../src/profiler/insights.js';

describe('byte strip', () => {
	const doc =
		'<!doctype html><html><head><title>x</title><script data-ogygia-runtime src="/r.js"></script><style>.a{}</style><link rel="stylesheet" href="/a/b.css"></head>' +
		'<body><p>hi</p>' +
		'<ogygia-region data-og-fp="0000aaaa1111bbbb" entry="/_app/x.js"><div><template shadowrootmode="open"><b>ds</b></template><script>inner()</script></div></ogygia-region>' +
		'<template shadowrootmode="open"><i>loose</i></template>' +
		'<script type="application/ogygia-page">{"data":{"a":1}}</script>' +
		'<script type="application/ogygia-props" data-ogygia-props>[]</script>' +
		'<script type="application/ogygia-holes" data-ogygia-holes>{}</script>' +
		'<script src="/_app/start.js" type="module"></script></body></html>';

	it('cuts the document into ordered, gap-free segments by what each byte is', () => {
		const s = byte_strip(doc);
		expect(s.total).toBe(doc.length);
		// contiguous, in order, ending at the end
		let pos = 0;
		for (const seg of s.segments) {
			expect(seg.start).toBe(pos);
			expect(seg.end).toBeGreaterThan(seg.start);
			pos = seg.end;
		}
		expect(pos).toBe(doc.length);
		const kinds = s.segments.map((x) => x.kind);
		expect(kinds).toEqual(['head', 'runtime', 'style', 'css-link', 'head', 'markup', 'island', 'shadow', 'seed', 'props', 'holes', 'script', 'markup']);
		// the island is ONE block whatever sits inside it (its shadow root and script are its bytes)
		const island = s.segments.find((x) => x.kind === 'island')!;
		expect(island.label).toBe('0000aaaa1111bbbb');
		expect(doc.slice(island.start, island.end)).toMatch(/^<ogygia-region[\s\S]*<\/ogygia-region>$/);
		// shadow DOM is counted everywhere, islands included
		expect(s.shadow_count).toBe(2);
		expect(s.by_kind.shadow).toBe(s.shadow_bytes);
		expect(s.by_kind.island).toBe(island.end - island.start);
		expect(s.segments.find((x) => x.kind === 'css-link')!.label).toBe('b.css');
		expect(s.segments.find((x) => x.kind === 'script')!.label).toBe('src start.js');
	});

	it('a document without ogygia at all, or a broken one, still strips', () => {
		const s = byte_strip('<html><body><p>plain</p></body></html>');
		expect(s.segments.map((x) => x.kind)).toEqual(['markup']);
		expect(byte_strip('').segments).toEqual([]);
		expect(byte_strip('<script>never closed').segments.map((x) => x.kind)).toEqual(['markup']);
	});

	it('a byte arrives in proportion to its place in the download', () => {
		expect(arrival_ms({ start: 500, end: 1000 }, 1000, 100, 300)).toEqual({ first: 200, last: 300 });
		expect(arrival_ms({ start: 0, end: 10 }, 0, 100, 300)).toEqual({ first: 100, last: 100 });
	});
});

describe('visit + one clock', () => {
	const raw = {
		at: 1_700_000_000_000,
		nav: { req_start: 5, res_start: 120, res_end: 180, dcl: 400, load: 900, size: 200_000, protocol: 'h2' },
		paints: { fcp: 350, lcp: 700, lcp_fp: '0000aaaa1111bbbb' },
		resources: [
			{ url: 'http://h/_app/a.css', type: 'css', start: 130, end: 300, blocking: true, transfer: 10_000 },
			{ url: 'http://h/_app/b.js', type: 'script', start: 140, end: 500, size: 50_000 },
			{ url: 'http://h/hero.jpg', type: 'img', start: 200, end: 650 },
			{ url: 'junk', type: 'css', start: 'x', end: 1 }
		],
		longtasks: [{ t: 520, ms: 80 }],
		islands: [{ fp: '0000aaaa1111bbbb', entry: '/_app/Hero.js', t0: 500, loaded: 560, done: 690 }, { fp: 'nope', t0: 1, done: 2 }],
		firsts: [{ fp: '0000aaaa1111bbbb', t: 1500, type: 'click' }],
		shifts: [{ t: 600, value: 0.12, fp: '0000aaaa1111bbbb', from: [0, 100, 800, 300], to: [0, 400, 800, 300] }, { t: 1, value: 'x' }],
		viewport: [1200, 800],
		marks: [{ name: 'ds.hydrate', t0: 200, ms: 300 }]
	};

	it('parse_visit bounds and drops junk; rejects what is not a visit', () => {
		const v = parse_visit('/p', raw)!;
		expect(v.page).toBe('/p');
		expect(v.resources).toHaveLength(3);
		expect(v.islands).toHaveLength(1);
		expect(v.shifts).toHaveLength(1);
		expect(v.shifts[0].to).toEqual([0, 400, 800, 300]);
		expect(v.viewport).toEqual([1200, 800]);
		expect(v.marks![0]).toEqual({ name: 'ds.hydrate', t0: 200, ms: 300 });
		expect(v.nav.protocol).toBe('h2');
		expect(parse_visit('/p', { nav: {} })).toBeNull();
		expect(parse_visit('nope', raw)).toBeNull();
		expect(parse_visit('/p', 'x')).toBeNull();
		expect(parse_visit('/p', { ...raw, resources: Array.from({ length: 500 }, () => raw.resources[0]) })!.resources).toHaveLength(200);
	});

	it('one_clock: the server render ends at the first byte, lanes per resource type, islands, marks, and a critical path to first paint and LCP', () => {
		const v = parse_visit('/p', raw)!;
		const clock = one_clock(v, { window_ms: 100, phases: [{ phase: 'load', cpu_ms: 10, wait_ms: 50 }, { phase: 'render', cpu_ms: 40, wait_ms: 0 }] }, { '0000aaaa1111bbbb': 'Hero' });
		expect(clock.server_at).toEqual({ t0: 20, t1: 120, clipped: false });
		expect(clock.lanes.map((l) => l.name)).toEqual(['server render', 'document', 'css (1)', 'script (1)', 'img (1)', 'main thread busy', 'islands (1)']);
		const server = clock.lanes[0].bars;
		expect(server.map((b) => [b.label, b.t0, b.t1])).toEqual([['load', 20, 80], ['render', 80, 120]]);
		expect(clock.lanes[1].bars.map((b) => b.kind)).toEqual(['ttfb', 'download']);
		const islands = clock.lanes.at(-1)!.bars;
		expect(islands.map((b) => b.label)).toEqual(['Hero · loading modules', 'Hero · hydrating']);
		expect(clock.marks.map((m) => m.kind)).toEqual(['fcp', 'lcp', 'dcl', 'load', 'first', 'mark']);
		// the critical path: the server's biggest phase, the first byte, the blocking css, then LCP's island
		expect(clock.critical.map((c) => c.id)).toEqual(['server:load', 'doc:ttfb', 'res:css:0', 'island:0000aaaa1111bbbb']);
		expect(clock.end).toBeGreaterThanOrEqual(900);
		// a render longer than the visit's TTFB is clipped and explained
		const clipped = one_clock(v, { window_ms: 5000, phases: [{ phase: 'render', cpu_ms: 5000, wait_ms: 0 }] });
		expect(clipped.server_at!.clipped).toBe(true);
		expect(clipped.notes[0]).toMatch(/clipped/);
		// no server timeline, no server lane
		expect(one_clock(v, null).lanes[0].group).toBe('document');
	});
});

describe('data river', () => {
	it('load_return_keys reads the object literals a load returns; spreads and non-literals are unknown', () => {
		expect(load_return_keys(`export async function load({ fetch }) {\n  const a = await fetch('/x');\n  return { products: await a.json(), 'total': 3, "flags": f, count };\n}`)).toEqual(['products', 'total', 'flags', 'count']);
		expect(load_return_keys(`export const load = async () => {\n if (x) return { a: 1 };\n return ({ b: { nested: 1 }, c: [1,2] });\n}`)).toEqual(['a', 'b', 'c']);
		expect(load_return_keys(`export const load: PageServerLoad = () => { return { ...parent, x: 1 } }`)).toBeNull();
		expect(load_return_keys(`export function load() { return data }`)).toBeNull();
		expect(load_return_keys(`export function other() { return { a: 1 } }`)).toBeNull();
		// strings and comments inside do not confuse the walk
		expect(load_return_keys(`export function load() { return { a: "}, b: 1", /* c: 2 */ d: '{' } }`)).toEqual(['a', 'd']);
	});

	it('seed_key_bytes measures each top-level key, unwrapping the seed shapes', () => {
		expect(seed_key_bytes('{"data":{"a":1,"b":[1,2,3]}}')).toEqual({ a: 1, b: 7 });
		expect(seed_key_bytes('{"page":{"data":{"x":"yy"}}}')).toEqual({ x: 4 });
		expect(seed_key_bytes('{"k":1}')).toEqual({ k: 1 });
		expect(seed_key_bytes('not json')).toEqual({});
		expect(seed_key_bytes('[1]')).toEqual({});
		// devalue: a flat node array, the root's `data` object maps keys to node indices; a key's
		// bytes are the nodes reachable from it, a shared node counting for each key that reaches it
		const devalue = JSON.stringify([
			{ url: 1, data: 2 }, // 0 root
			'http://x/p', // 1
			{ products: 3, meta: 6, when: 8, nothing: -1 }, // 2 data
			[4, 5], // 3 products: two items
			{ name: 7 }, // 4
			{ name: 7 }, // 5
			{ shared: 7 }, // 6 meta shares node 7 with the products
			'a-long-shared-string-value', // 7
			['Date', '2026-09-20T00:00:00.000Z'] // 8 a typed leaf
		]);
		const b = seed_key_bytes(devalue);
		const s = (n: unknown) => JSON.stringify(n).length;
		expect(b.products).toBe(s([4, 5]) + 2 * s({ name: 7 }) + s('a-long-shared-string-value'));
		expect(b.meta).toBe(s({ shared: 7 }) + s('a-long-shared-string-value'));
		expect(b.when).toBe(s(['Date', '2026-09-20T00:00:00.000Z']));
		expect(b.nothing).toBe(0);
	});

	it('merge_visits folds two records of one visit: arrays union, the later navigation and paints win', () => {
		const a = parse_visit('/p', { at: 5, nav: { req_start: 0, res_start: 100, res_end: 120 }, islands: [{ fp: '0000aaaa1111bbbb', t0: 1, loaded: 2, done: 3 }], firsts: [], shifts: [], longtasks: [] })!;
		const b = parse_visit('/p', { at: 5, nav: { req_start: 0, res_start: 100, res_end: 120, load: 900 }, paints: { lcp: 700 }, islands: [{ fp: '0000aaaa1111bbbb', t0: 1, loaded: 2, done: 3 }, { fp: 'cafebabecafebabe', t0: 4, loaded: 5, done: 6 }], marks: [{ name: 'm', ms: 3 }], shifts: [{ t: 1, value: 0.1 }] })!;
		const m = merge_visits(a, b);
		expect(m.islands.map((i) => i.fp)).toEqual(['0000aaaa1111bbbb', 'cafebabecafebabe']);
		expect(m.nav.load).toBe(900);
		expect(m.paints.lcp).toBe(700);
		expect(m.marks).toEqual([{ name: 'm', ms: 3 }]);
		expect(m.shifts).toHaveLength(1);
	});

	it('build_river: calls feed loads, loads feed keys, keys feed islands; waste and notes', () => {
		const r = build_river({
			calls: [
				{ lane: 'routes/p/+page.server.ts', label: 'GET http://api/products?x=1', ms: 200 },
				{ lane: 'routes/p/+page.server.ts', label: 'GET http://api/products?x=2', ms: 150 },
				{ lane: null, label: 'GET http://api/track', ms: 30 }
			],
			lanes: [{ file: 'routes/p/+page.server.ts', keys: ['products', 'flags'] }],
			islands: [{ name: 'Card', keys: ['products'] }, { name: 'Footer', keys: [] }],
			seed: { products: 40_000, flags: 200, unused: 9000 }
		});
		const ids = (col: number) => r.nodes.filter((n) => n.col === col).map((n) => n.label);
		expect(ids(0)).toEqual(['GET /products ×2', 'GET /track']);
		expect(ids(1)).toEqual(['routes/p/+page.server.ts', 'outside a load', 'a load outside the window']);
		expect(ids(2)).toEqual(['products', 'flags', 'unused']);
		expect(ids(3)).toEqual(['Card', 'Footer']);
		expect(r.links.find((l) => l.from.startsWith('call:') && l.to === 'load:routes/p/+page.server.ts')!.value).toBe(350);
		expect(r.links.filter((l) => l.to === 'island:Card').map((l) => l.from)).toEqual(['key:products']);
		expect(r.waste).toEqual([{ key: 'unused', bytes: 9000 }, { key: 'flags', bytes: 200 }]);
		expect(r.notes[0]).toMatch(/2 keys in the seed that no island reads/);
		// an island that reads everything takes every key, and the note says why the seed is whole
		const all = build_river({ calls: [], lanes: [], islands: [{ name: 'X', keys: null }], seed: { a: 1, b: 2 } });
		expect(all.links.filter((l) => l.to === 'island:X')).toHaveLength(2);
		expect(all.waste).toEqual([]);
		expect(all.notes[0]).toMatch(/No island names the keys/);
	});
});

describe('dom diff + shift boxes', () => {
	it('tokenizes tags and text, diffs by token, and reports what changed', () => {
		expect(tokenize_html('<p class="a">hi <b>x</b></p>')).toEqual(['<p class="a">', 'hi ', '<b>', 'x', '</b>', '</p>']);
		const d = html_diff('<p>hello <b>world</b></p>', '<p>hello <i>world</i></p>');
		expect(d.ops.map((o) => o.kind)).toEqual(['same', 'del', 'add', 'same', 'del', 'add', 'same']);
		expect(d.removed).toBe('<b>'.length + '</b>'.length);
		expect(d.added).toBe('<i>'.length + '</i>'.length);
		expect(d.same_ratio).toBeLessThan(1);
		expect(html_diff('<a>x</a>', '<a>x</a>')).toMatchObject({ added: 0, removed: 0, same_ratio: 1, truncated: false });
		// a huge middle is not diffed token by token
		const big = html_diff('<p>' + 'a '.repeat(3000) + '</p>', '<p>' + 'b '.repeat(3000) + '</p>');
		expect(big.truncated).toBe(true);
		expect(big.ops.map((o) => o.kind)).toEqual(['same', 'del', 'add', 'same']);
	});

	it('shift boxes normalize to the viewport, biggest first, skipping shifts with no rect', () => {
		const boxes = shift_boxes(
			[
				{ t: 1, value: 0.02, from: [0, 0, 600, 100], to: [0, 50, 600, 100] },
				{ t: 2, value: 0.3, fp: 'ab', to: [300, 400, 300, 200] },
				{ t: 3, value: 0.5 }
			],
			[600, 800]
		);
		expect(boxes.map((b) => b.value)).toEqual([0.3, 0.02]);
		expect(boxes[0]).toMatchObject({ x: 0.5, y: 0.5, w: 0.5, h: 0.25, fp: 'ab' });
		expect(boxes[1].fy).toBe(0);
		expect(shift_boxes([{ t: 1, value: 1, to: [0, 0, 1, 1] }], undefined)).toEqual([{ x: 0, y: 0, w: 1, h: 1, fx: 0, fy: 0, value: 1, t: 1 }]);
	});
});

describe('sink', () => {
	const req = (t: number, route: string, ms: number, cpu: number, wait: number): SinkRow => ({ k: 'req', t, path: route, route, ms, cpu, wait, status: 200 });
	it('buffers rows, drops the oldest request rows first when full, drains NDJSON that parses back', () => {
		const b = new SinkBuffer(400);
		for (let i = 0; i < 20; i++) b.push(req(i, '/a', 10, 5, 2));
		b.push({ k: 'win', t0: 0, t1: 1000, fns: [{ name: 'f', file: 'x.ts', self_ms: 3, category: 'app' }] });
		expect(b.size).toBeLessThan(21);
		const text = b.drain();
		const rows = parse_sink(text + '\n{bad json\n');
		expect(rows.some((r) => r.k === 'win')).toBe(true);
		expect(rows.every((r) => r.k === 'req' || r.k === 'win')).toBe(true);
		expect(b.size).toBe(0);
		expect(b.drain()).toBe('');
	});
	it('cloud points, the layer cake per route, and the hot functions of a brushed range', () => {
		const rows: SinkRow[] = [
			req(100, '/a', 100, 60, 30),
			req(200, '/a', 300, 100, 150),
			req(300, '/b', 50, 50, 0),
			{ k: 'win', t0: 0, t1: 1000, fns: [{ name: 'slow', file: 'a.ts', self_ms: 40, category: 'app' }, { name: 'fmt', file: 'b.ts', self_ms: 10, category: 'app' }] },
			{ k: 'win', t0: 1000, t1: 2000, fns: [{ name: 'slow', file: 'a.ts', self_ms: 20, category: 'app' }] },
			{ k: 'trap', t: 5, path: '/x', ms: 900, id: 'r1' }
		];
		expect(cloud_points(rows).map((p) => p.ms)).toEqual([100, 300, 50]);
		const cake = layer_cake(rows);
		expect(cake.map((c) => c.route)).toEqual(['/a', '/b']);
		expect(cake[0]).toMatchObject({ n: 2, total: 400, cpu: 160, wait: 180, rest: 60, p50: 300 });
		expect(cake[1]).toMatchObject({ n: 1, cpu: 50, wait: 0, rest: 0 });
		// a range covering the whole first window and half the second
		const hot = hot_for_range(rows, 0, 1500);
		expect(hot[0]).toEqual({ name: 'slow', file: 'a.ts', category: 'app', self_ms: 50, windows: 2 });
		expect(hot[1].self_ms).toBe(10);
		expect(hot_for_range(rows, 5000, 6000)).toEqual([]);
	});
});

describe('who caused the GC', () => {
	const frame = (functionName: string, url: string, line = 1) => ({ functionName, url, lineNumber: line, columnNumber: 0, scriptId: '1' });
	// ProductCard → toProductVM → structuredClone allocates; a helper `fmt` allocates a little; svelte's runtime is on the stack too
	const tree = (a: number, b: number, c: number) => ({
		callFrame: frame('(root)', ''),
		selfSize: 0,
		children: [
			{
				callFrame: frame('ProductCard', '/app/src/lib/ProductCard.svelte'),
				selfSize: 0,
				children: [
					{ callFrame: frame('toProductVM', '/app/src/lib/mappers.ts', 10), selfSize: 0, children: [{ callFrame: frame('structuredClone', ''), selfSize: a }] },
					{ callFrame: frame('fmt', '/app/src/lib/fmt.ts', 3), selfSize: b }
				]
			},
			{ callFrame: frame('set_text', '/app/node_modules/svelte/src/internal/server/index.js'), selfSize: c }
		]
	});

	it('heap_sites keys each allocating stack, names the nearest component; slice_delta is the growth between reads', () => {
		const dict = {};
		const s1 = heap_sites(tree(1000, 200, 50), dict);
		const s2 = heap_sites(tree(5000, 200, 150), dict);
		expect(s1.size).toBe(3);
		const d = slice_delta(s1, s2);
		const by_name = Object.fromEntries(Object.entries(d).map(([k, v]) => [dict[k as keyof typeof dict].name, v]));
		expect(by_name).toEqual({ structuredClone: 4000, set_text: 100 });
		const clone = Object.values(dict).find((x) => x.name === 'structuredClone')!;
		expect(clone.component).toBe('ProductCard');
		// the caller is the nearest APP frame above (structuredClone is a builtin, its line is nobody's)
		expect(clone.caller).toBe('toProductVM (lib/mappers.ts:11)');
		expect(Object.values(dict).find((x) => x.name === 'set_text')!.component).toBeNull();
		// the same stack reads the same key across reads
		expect([...s1.keys()].sort()).toEqual([...s2.keys()].sort());
	});

	it('attribute_gc charges each pause to what was allocated since the previous one, and each maker its share of pause time', () => {
		const dict = {};
		const reads = [tree(0, 0, 0), tree(8_000_000, 100_000, 0), tree(16_000_000, 200_000, 500_000), tree(16_000_000, 200_000, 500_000)];
		const sites = reads.map((t) => heap_sites(t, dict));
		const slices = [
			{ t0: 0, t1: 20, bytes: slice_delta(sites[0], sites[1]) },
			{ t0: 20, t1: 40, bytes: slice_delta(sites[1], sites[2]) },
			{ t0: 40, t1: 60, bytes: slice_delta(sites[2], sites[3]) }
		];
		const events = [
			{ t: 18, ms: 4, kind: 'minor' as const, flags: 0 },
			{ t: 39, ms: 6, kind: 'minor' as const, flags: 0 },
			{ t: 58, ms: 20, kind: 'major' as const, flags: 0 },
			{ t: 59, ms: 1, kind: 'minor' as const, flags: 4 }
		];
		const g = attribute_gc({ slices, events, dict, window_ms: 60, retained_mb: 3 });
		expect(g.summary).toMatchObject({ count: 4, total_ms: 31, max_ms: 20, minor: 3, major: 1, incremental: 0, weak: 0, retained_mb: 3, slices: 3, slice_ms: 20 });
		expect(g.summary.allocated_mb).toBeCloseTo(15.9, 0); // 16.7 M bytes
		// the first pause at 18 ms: 18/20 of the first read's 8.1 MB, structuredClone 99%
		expect(g.pauses[0].top[0]).toMatchObject({ name: 'structuredClone', component: 'ProductCard' });
		expect(g.pauses[0].top[0].share).toBeGreaterThan(0.95);
		expect(g.pauses[0].allocated).toBe(Math.round(8_100_000 * 0.9));
		expect(g.pauses[0].why).toMatch(/young space filled: 7 MB allocated in the 18 ms/);
		// the second (18 → 39 ms): the rest of the first read and 19/20 of the second
		expect(g.pauses[1].allocated).toBe(Math.round(8_100_000 * 0.1 + 8_600_000 * 0.95));
		// the major one is charged from the window start (no earlier major pause): both reads whole
		expect(g.pauses[2].allocated).toBe(16_000_000 + 200_000 + 500_000);
		expect(g.pauses[2].why).toMatch(/old space grew/);
		expect(g.pauses[3].forced).toBe(true);
		expect(g.pauses[3].why).toMatch(/forced/);
		// makers: structuredClone carries nearly all the pause time
		expect(g.makers[0]).toMatchObject({ name: 'structuredClone', component: 'ProductCard', caller: 'toProductVM (lib/mappers.ts:11)', pauses: 3 });
		expect(g.makers[0].gc_ms).toBeGreaterThan(25);
		expect(g.makers[0].share).toBeGreaterThan(0.9);
		expect(g.components[0]).toMatchObject({ name: 'ProductCard' });
		expect(g.components[0].gc_ms).toBeGreaterThan(25);
		// the same line reached through two stacks is ONE maker
		const two = (x: number) => ({ callFrame: frame('(root)', ''), selfSize: 0, children: [{ callFrame: frame('loop', '/app/src/lib/ds.ts', 5), selfSize: 0, children: [{ callFrame: frame('a', '/app/src/lib/ds.ts', 6), selfSize: 0, children: [{ callFrame: frame('replace', ''), selfSize: x }] }, { callFrame: frame('b', '/app/src/lib/ds.ts', 7), selfSize: 0, children: [{ callFrame: frame('replace', ''), selfSize: x }] }] }] });
		const d2 = {};
		const r0 = heap_sites(two(0), d2);
		const r1 = heap_sites(two(1000), d2);
		const merged = attribute_gc({ slices: [{ t0: 0, t1: 10, bytes: slice_delta(r0, r1) }], events: [{ t: 9, ms: 2, kind: 'minor', flags: 0 }], dict: d2, window_ms: 10 });
		// a and b are different app callers, so two rows; each reached once
		expect(merged.makers.map((m) => `${m.name} ← ${m.caller}`).sort()).toEqual(['replace ← a (lib/ds.ts:7)', 'replace ← b (lib/ds.ts:8)']);
		// no slices, no events: an empty, well-formed answer
		expect(attribute_gc({ slices: [], events: [], dict: {}, window_ms: 10 })).toMatchObject({ summary: { count: 0, total_ms: 0, max_ms: 0, allocated_mb: 0 }, pauses: [], makers: [], components: [] });
	});

	it('gc_kind reads Node’s kind bits', () => {
		expect([1, 4, 8, 16, 0].map(gc_kind)).toEqual(['minor', 'major', 'incremental', 'weak', 'other']);
	});
});

describe('as if the profiler were not there', () => {
	const frame = (functionName: string, url: string, line = 1) => ({ functionName, url, lineNumber: line, columnNumber: 0, scriptId: '1' });
	it('a pause is charged as the app would have paid it: the profiler’s own share of the allocations before it is taken out', () => {
		const dict = {};
		const tree = (app: number, prof: number) => ({
			callFrame: frame('(root)', ''),
			selfSize: 0,
			children: [
				{ callFrame: frame('Page', '/app/src/lib/Page.svelte'), selfSize: 0, children: [{ callFrame: frame('render', '/app/src/lib/Page.svelte'), selfSize: app }] },
				{ callFrame: frame('heap_sites', '/x/node_modules/ogygia/dist/profiler/gc.js'), selfSize: prof }
			]
		});
		const sites = heap_sites(tree(3000, 1000), dict);
		const bytes: Record<string, number> = {};
		for (const [k, v] of sites) bytes[k] = v;
		const g = attribute_gc({ slices: [{ t0: 0, t1: 10, bytes }], events: [{ t: 9, ms: 8, kind: 'minor', flags: 0 }], dict, window_ms: 10, running: [{ t0: 0, t1: 5, label: 'Header', category: 'component', file: 'src/lib/Header.svelte' }, { t0: 5, t1: 10, label: 'render', category: 'component', file: 'src/lib/Page.svelte' }] });
		// 1000 of 4000 bytes were the profiler's: a quarter of the 8 ms pause is its
		expect(g.pauses[0].ms_measured).toBe(8);
		expect(g.pauses[0].ms).toBe(6);
		// one read over the window: no per-pause allocators, the stretch's bytes are at the window's rate, and the timeline says what ran
		expect(g.pauses[0].top).toEqual([]);
		expect(g.pauses[0].estimated).toBe(true);
		expect(g.pauses[0].allocated).toBe(Math.round(3000 * 0.9));
		expect(g.pauses[0].why).toMatch(/≈/);
		expect(g.pauses[0].running).toEqual({ label: 'render', category: 'component', file: 'src/lib/Page.svelte' });
		// the moment of the pause is the collector's own segment: the answer is the app's work just before it
		const g2 = attribute_gc({ slices: [{ t0: 0, t1: 10, bytes }], events: [{ t: 9, ms: 8, kind: 'minor', flags: 0 }], dict, window_ms: 10, running: [{ t0: 0, t1: 8, label: 'render', category: 'component', file: 'src/lib/Page.svelte' }, { t0: 8, t1: 10, label: 'garbage collection', category: 'gc' }] });
		expect(g2.pauses[0].running?.label).toBe('render');
		expect(g.summary).toMatchObject({ measured_ms: 8, overhead_ms: 2, total_ms: 6, max_ms: 6 });
		expect(g.makers.map((m) => `${m.name} in ${m.component}`)).toEqual(['render in Page']);
		expect(g.makers[0].gc_ms).toBe(6);
	});
});

describe('more from the same snapshot', () => {
	const frame = (functionName: string, url: string, line = 1) => ({ functionName, url, lineNumber: line, columnNumber: 0, scriptId: '1' });
	it('deopts: the reasons V8 wrote into the profile, per function, with self time', () => {
		const p = {
			startTime: 0,
			endTime: 40_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)', ''), children: [2, 3, 4] },
				{ id: 2, callFrame: frame('fmt', '/app/src/lib/fmt.ts', 3), deoptReason: 'wrong map' },
				{ id: 3, callFrame: frame('fmt', '/app/src/lib/fmt.ts', 3), deoptReason: 'not a Smi' },
				{ id: 4, callFrame: frame('other', '/app/src/lib/x.ts', 1) }
			],
			samples: [2, 3, 3, 4],
			timeDeltas: [10_000, 10_000, 10_000, 10_000]
		};
		const a = analyze(p as never);
		expect(a.deopts).toHaveLength(1);
		expect(a.deopts[0]).toMatchObject({ name: 'fmt', count: 2, reasons: { 'wrong map': 1, 'not a Smi': 1 }, self_ms: 30 });
	});
	it('sync_io names the blocking node calls with their app callers; memo candidates need many calls at a steady cost', () => {
		const p = {
			startTime: 0,
			endTime: 50_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)', ''), children: [2] },
				{ id: 2, callFrame: frame('load', '/app/src/routes/+page.server.ts', 4), children: [3, 4] },
				{ id: 3, callFrame: frame('readFileSync', 'node:fs', 1) },
				{ id: 4, callFrame: frame('toVM', '/app/src/lib/mappers.ts', 9) }
			],
			samples: [3, 3, 4, 4, 4],
			timeDeltas: [10_000, 10_000, 10_000, 10_000, 10_000]
		};
		const a = analyze(p as never, undefined, { 'toVM\0/app/src/lib/mappers.ts': 48, 'readFileSync\0node:fs': 2 });
		const s = sync_io(a);
		expect(s).toHaveLength(1);
		expect(s[0]).toMatchObject({ name: 'readFileSync', module: 'node:fs', total_ms: 20, calls: 2 });
		expect(s[0].callers[0]).toMatch(/^load/);
		const m = memo_candidates(a, [{ key: 'k', name: 'toVM', url: '/app/src/lib/mappers.ts', line: 9, category: 'app', component: null, allocated: 480_000, share: 0.5, gc_ms: 1, pauses: 0 }]);
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ name: 'toVM', calls: 48, total_ms: 30, alloc_per_call: 10_000 });
		expect(m[0].per_call_ms).toBeCloseTo(0.625, 3);
	});
	it('simulate_awaits: parallel starts a call with the one it waited for, cache makes it instant, remove takes it out', () => {
		// a → b → c in a row, each 100 ms with 5 ms between; 50 ms of CPU after the last
		const nodes = [
			{ label: 'a', t0: 0, t1: 100, lane: 0, kind: 'net' },
			{ label: 'b', t0: 105, t1: 205, lane: 0, kind: 'net' },
			{ label: 'c', t0: 210, t1: 310, lane: 0, kind: 'net' }
		];
		const edges = [{ from: 'a', to: 'b', gap_ms: 5 }, { from: 'b', to: 'c', gap_ms: 5 }];
		const base = simulate_awaits(nodes, edges, 360, {});
		expect(base).toMatchObject({ before_ms: 360, after_ms: 360, delta_ms: 0, chain: ['a', 'b', 'c'] });
		const par = simulate_awaits(nodes, edges, 360, { b: 'parallel', c: 'parallel' });
		expect(par.after_ms).toBe(150); // all three start at 0, the longest ends at 100, plus the 50 ms tail
		expect(par.delta_ms).toBe(-210);
		const cached = simulate_awaits(nodes, edges, 360, { b: 'cache' });
		expect(cached.after_ms).toBe(260); // b is instant: c starts at 105 + 5, ends 210, + 50
		const removed = simulate_awaits(nodes, edges, 360, { a: 'remove' });
		expect(removed.after_ms).toBe(255); // b keeps nothing to wait for: starts at min(105, 0) = 0, c at 105
		expect(removed.nodes.find((n) => n.label === 'b')!.moved).toBe(true);
	});
});
