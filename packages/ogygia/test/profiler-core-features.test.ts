/**
 * The six core readings added on top of the snapshot: the stack index and its queries, the
 * allocation timeline, the instance's other requests, the data lineage from the code, the render
 * stepper, and the spans' values. Pure modules, exercised with hand-built inputs.
 */
import { describe, expect, it } from 'vitest';
import { analyze, build_stack_index, type CpuProfile } from '../src/profiler/analyze.js';
import { range_hot, stack_at, density } from '../src/profiler/stacks.js';
import { alloc_timeline } from '../src/profiler/alloc.js';
import { contention } from '../src/profiler/contention.js';
import { data_reads, data_prop_names, build_lineage } from '../src/profiler/lineage.js';
import { render_steps } from '../src/profiler/steps.js';
import { span_values } from '../src/profiler/insights.js';
import type { RequestEntry } from '../src/profiler/report.js';
import type { Timeline } from '../src/profiler/timeline.js';
import type { SpanRecord } from '../src/profiler/span.js';

// a profile: (root) → load (routes/x/+page.server.ts) → fetchData ; (root) → Page.svelte → Card.svelte
function profile(): CpuProfile {
	const frame = (functionName: string, url: string, lineNumber = 1) => ({ functionName, url, lineNumber, columnNumber: 0, scriptId: '1' });
	return {
		nodes: [
			{ id: 1, callFrame: frame('(root)', ''), children: [2, 4, 6] },
			{ id: 2, callFrame: frame('load', 'file:///app/src/routes/x/+page.server.ts', 3), children: [3] },
			{ id: 3, callFrame: frame('fetchData', 'file:///app/src/lib/data.ts', 9) },
			{ id: 4, callFrame: frame('Page', 'file:///app/src/routes/x/+page.svelte', 1), children: [5] },
			{ id: 5, callFrame: frame('Card', 'file:///app/src/lib/Card.svelte', 1) },
			{ id: 6, callFrame: frame('(idle)', '') }
		],
		startTime: 0,
		endTime: 10_000,
		// 10 samples of 1 ms: fetchData ×3, Card ×4, idle ×2, Page ×1
		samples: [3, 3, 3, 5, 5, 5, 5, 6, 6, 4],
		timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]
	};
}

describe('the stack index', () => {
	it('folds consecutive samples of one leaf and keeps the parent links', () => {
		const p = profile();
		const frames = new Map(p.nodes.map((n) => [n.id, n]));
		const parent = new Map<number, number>();
		for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
		const idx = build_stack_index(
			p,
			(id) => {
				const n = frames.get(id)!;
				const name = n.callFrame.functionName;
				const cat = name === '(root)' || name === '(idle)' ? 'idle' : name === 'Page' || name === 'Card' ? 'component' : 'app';
				return { name, url: n.callFrame.url, line: n.callFrame.lineNumber, category: cat };
			},
			(id) => parent.get(id),
			100,
			{ start: 100, end: 110 }
		)!;
		expect(idx).toBeDefined();
		expect(idx.raw).toBe(10);
		// fetchData ×3 → 1, Card ×4 → 1, idle ×2 → 1, Page → 1
		expect(idx.leaf.length).toBe(4);
		expect(idx.d).toEqual([3, 4, 2, 1]);
		expect(idx.leaf[2]).toBe(-1);
		const card = idx.frames[idx.leaf[1]];
		expect(card.n).toBe('Card');
		expect(idx.frames[card.p].n).toBe('Page');
		expect(idx.frames[idx.frames[card.p].p]?.n).toBeUndefined();
		expect(idx.window_ms).toBe(10);
	});

	it('answers a range and an instant', () => {
		const a = analyze(profile(), undefined, undefined, { perf_start: 100, window: { start: 100, end: 110 }, calls: [] });
		const idx = a.stacks!;
		expect(idx).toBeDefined();
		const whole = range_hot(idx, 0, 10);
		expect(whole.cpu_ms).toBe(8);
		expect(whole.idle_ms).toBe(2);
		expect(whole.self[0].name).toBe('Card');
		expect(whole.self[0].self_ms).toBe(4);
		// Page owns Card's 4 ms and its own 1
		const page = whole.total.find((r) => r.name === 'Page')!;
		expect(page.total_ms).toBe(5);
		expect(whole.components.map((c) => c.name)).toContain('Card');
		// the first 3 ms are fetchData under load
		const early = range_hot(idx, 0, 3);
		expect(early.self.map((r) => r.name)).toEqual(['fetchData']);
		expect(early.total.map((r) => r.name).sort()).toEqual(['fetchData', 'load']);
		// a straddling sample counts by its overlap
		expect(range_hot(idx, 2.5, 3.5).self[0].self_ms).toBe(0.5);
		const at = stack_at(idx, 4.5)!;
		expect(at.frames.map((f) => f.name)).toEqual(['Page', 'Card']);
		expect(stack_at(idx, 7.5)!.frames).toEqual([]);
		expect(stack_at(idx, 99)).toBeNull();
		const dens = density(idx, 10);
		expect(dens.length).toBe(10);
		expect(dens.reduce((x, y) => x + y, 0)).toBeCloseTo(8, 1);
		// Card is the one leaf that is a component here (Page is on the stack, not the leaf, for 4 of the 5)
		expect(density(idx, 10, 'component').reduce((x, y) => x + y, 0)).toBeGreaterThanOrEqual(4);
	});

	it('is absent without a window and stride-samples past the cap', () => {
		expect(analyze(profile()).stacks).toBeUndefined();
		const big: CpuProfile = { nodes: profile().nodes, startTime: 0, endTime: 0, samples: [], timeDeltas: [] };
		// alternate leaves so nothing folds: 30k samples
		for (let i = 0; i < 30_000; i++) {
			big.samples!.push(i % 2 ? 3 : 5);
			big.timeDeltas!.push(100);
		}
		big.endTime = 30_000 * 100;
		const a = analyze(big, undefined, undefined, { perf_start: 0, window: { start: 0, end: 3000 }, calls: [] });
		expect(a.stacks!.raw).toBe(30_000);
		expect(a.stacks!.leaf.length).toBeLessThanOrEqual(20_000);
		// the lengths still sum to the CPU
		expect(a.stacks!.d.reduce((x, y) => x + y, 0)).toBeCloseTo(3000, 0);
	});
});

describe('allocation on the timeline', () => {
	it('finds the bursts, attributes them to what ran, and flags a GC inside', () => {
		const samples = [
			{ t: 0, mb: 100 },
			{ t: 20, mb: 101 },
			{ t: 40, mb: 130 }, // +29 in 20 ms: the burst
			{ t: 60, mb: 131 },
			{ t: 80, mb: 90 }, // a collection: the heap shrank
			{ t: 100, mb: 95 }
		];
		const running = [
			{ t0: 0, t1: 25, label: 'Header', category: 'component' },
			{ t0: 25, t1: 40, label: 'toVM', category: 'app', file: 'lib/vm.ts:3' },
			{ t0: 40, t1: 100, label: 'Footer', category: 'component' }
		];
		const out = alloc_timeline({ samples, running, gc: [{ t: 85, ms: 5 }], window: { offset_ms: 10, ms: 50 } })!;
		expect(out.grown_mb).toBe(36);
		expect(out.period_ms).toBe(20);
		expect(out.longest_gap_ms).toBe(20);
		expect(out.bursts[0].t0).toBe(20);
		expect(out.bursts[0].mb).toBe(29);
		expect(out.bursts[0].rate).toBe(1450);
		expect(out.bursts[0].running[0].label).toBe('toVM');
		expect(out.bursts[0].running[0].share).toBe(0.75);
		expect(out.bursts[0].running[0].file).toBe('lib/vm.ts:3');
		expect(out.bursts[0].gc).toBe(false);
		// the interval with the pause inside it
		const with_gc = out.bursts.find((b) => b.t0 === 80);
		expect(with_gc?.gc).toBe(true);
		expect(out.window).toEqual({ offset_ms: 10, ms: 50 });
		expect(alloc_timeline({ samples: samples.slice(0, 2) })).toBeUndefined();
	});
});

describe('the instance was not alone', () => {
	const req = (path: string, pt: number, ms: number, cpu_ms: number, extra: Partial<RequestEntry> = {}): RequestEntry => ({ ts: 0, method: 'GET', path, route: null, status: 200, ms, cpu_ms, inflight: 0, net_ms: 0, net_count: 0, pt, ...extra });
	it('names the overlapping requests with a bounded CPU estimate', () => {
		const out = contention({
			requests: [
				req('/a', 50, 100, 80), // overlaps 100..150: 50 ms, cpu 80 × 0.5 = 40
				req('/b', 400, 50, 10), // outside
				req('/__ogygia__/islands', 120, 20, 5, { hole: {} as never }),
				req('/hell', 100, 100, 90, { internal: true, inflight: 2 })
			],
			windows: [{ start: 100, end: 200 }],
			own: [req('/hell', 100, 100, 90, { internal: true, inflight: 2 })]
		})!;
		expect(out.requests.map((r) => r.path)).toEqual(['/a', '/__ogygia__/islands']);
		expect(out.requests[0].overlap_ms).toBe(50);
		expect(out.requests[0].cpu_max_ms).toBe(40);
		expect(out.requests[1].kind).toBe('hole');
		expect(out.inflight_at_start).toEqual([2]);
		// a path the render itself called is the render waiting on itself
		const self = contention({ requests: [req('/api/items', 120, 30, 5)], windows: [{ start: 100, end: 200 }], self_paths: new Set(['/api/items']) })!;
		expect(self.requests[0].kind).toBe('self');
		expect(out.per_window[0].n).toBe(2);
		// 100..150 and 120..140 → union 50 of 100
		expect(out.busy_share).toBe(0.5);
	});
	it('is absent when nothing overlapped', () => {
		expect(contention({ requests: [req('/b', 400, 50, 10)], windows: [{ start: 100, end: 200 }] })).toBeUndefined();
		expect(contention({ requests: [], windows: [] })).toBeUndefined();
	});
});

describe('data lineage from the code', () => {
	it('reads the keys a component touches, without regex', () => {
		const src = `<script lang="ts">
	let { data } = $props();
	const suggestions = data.catalog.products.map((p) => p.name);
	const { user, flags: f } = data;
	const x = data['legacy'];
	const meta = response.data.items; // not page data
	const y = page.data.session;
	const z = $page.data.locale;
</script>
<title>{data.catalog.title}</title>
<Child {data} />
<Other data={data} />`;
		expect(data_reads(src)!.sort()).toEqual(['catalog', 'flags', 'legacy', 'locale', 'session', 'user']);
		expect(data_prop_names(src)).toEqual(['data']);
	});
	it('sees a renamed prop, a spread, and a pass-through as whole', () => {
		const renamed = `let { data: pd } = $props();\nconst a = pd.items;`;
		expect(data_prop_names(renamed)).toEqual(['data', 'pd']);
		expect(data_reads(renamed, data_prop_names(renamed))).toEqual(['items']);
		expect(data_reads(`let { data } = $props();\nconst all = { ...data };`)).toBeNull();
		expect(data_reads(`let { data } = $props();\nconst k = data.a;\nfn(data);`)).toEqual(['a', '*']);
		expect(data_reads(`const metadata = 1; const dataset = 2;`)).toEqual([]);
		expect(data_reads(`const alias = data;\nconst keys = Object.keys(page.data);`)).toBeNull();
	});
	it('ignores attributes, import paths, comments and prose', () => {
		const src = `<script>
	import type { Product } from './data';
	import { columns } from '$lib/hell/data';
	// the page data comes from the load
	let { data } = $props();
	const n = data.items.length; /* data: items */
</script>
<article data-product={n} data-track="x">
	<p data-static-shell>{n} products in {n} data keys · data</p>
	<!-- data.hidden is not a read -->
</article>`;
		expect(data_reads(src)).toEqual(['items']);
	});
	it('gives every key a verdict', () => {
		const out = build_lineage({
			components: [
				{ name: 'x/+page.svelte', file: 'routes/x/+page.svelte', island: false, reads: ['catalog', 'title'] },
				{ name: 'Cart', file: 'lib/Cart.svelte', island: true, reads: ['cart'] }
			],
			lanes: [{ file: 'routes/x/+page.server.ts', keys: ['catalog', 'title', 'cart', 'legacy'], wait_ms: 120 }],
			seed: { catalog: 40_000, cart: 500, legacy: 2000 }
		})!;
		const by = Object.fromEntries(out.keys.map((k) => [k.key, k]));
		expect(by.cart.verdict).toBe('island');
		expect(by.catalog.verdict).toBe('server-only');
		expect(by.title.verdict).toBe('server'); // read on the server, not shipped: nothing to say
		expect(by.legacy.verdict).toBe('unread');
		expect(by.legacy.load_wait_ms).toBe(120);
		expect(out.unread.map((k) => k.key)).toEqual(['legacy']);
		expect(out.server_only.map((k) => k.key)).toEqual(['catalog']);
		expect(by.catalog.readers).toEqual([{ name: 'x/+page.svelte', island: false }]);
	});
	it('never calls a key unread when a reader could not be scanned or takes the whole object', () => {
		const blind = build_lineage({ components: [{ name: 'P', file: 'p.svelte', island: false, reads: null }], lanes: [{ file: 'l.ts', keys: ['a'] }], seed: {} })!;
		expect(blind.keys[0].verdict).toBe('unknown');
		expect(blind.notes[0]).toContain('could not name');
		const whole = build_lineage({ components: [{ name: 'P', file: 'p.svelte', island: false, reads: ['*'] }], lanes: [{ file: 'l.ts', keys: ['a'] }], seed: { a: 100 } })!;
		expect(whole.keys[0].verdict).toBe('unknown');
		expect(whole.components[0].whole).toBe(true);
		// an island that takes the page whole may read a key the server also names: not "server only"
		const island_whole = build_lineage({ components: [{ name: 'P', file: 'p.svelte', island: false, reads: ['a'] }, { name: 'I', file: 'i.svelte', island: true, reads: ['*'] }], lanes: [{ file: 'l.ts', keys: ['a'] }], seed: { a: 100 } })!;
		expect(island_whole.keys[0].verdict).toBe('unknown');
		expect(island_whole.keys[0].readers.map((r) => r.name)).toEqual(['P', 'I']);
		expect(build_lineage({ components: [], lanes: [], seed: {} })).toBeUndefined();
	});
});

describe('the render, step by step', () => {
	const tl = (): Timeline => ({
		window_ms: 100,
		cpu_ms: 60,
		wait_ms: 40,
		gap_ms: 0,
		overhead_ms: 0,
		segments: [
			{ t0: 0, t1: 10, kind: 'cpu', label: 'load', category: 'app', phase: 'load', file: 'routes/x/+page.server.ts:3' },
			{ t0: 10, t1: 50, kind: 'wait', label: 'GET api/items', category: 'idle', phase: 'load', calls: [{ label: 'GET api/items', ms: 40 }], within: 'db' },
			{ t0: 50, t1: 70, kind: 'cpu', label: 'Page', category: 'component', phase: 'render', detail: 'escape_html' },
			{ t0: 70, t1: 70.5, kind: 'cpu', label: 'Page', category: 'component', phase: 'render' },
			{ t0: 70.5, t1: 100, kind: 'cpu', label: 'Card', category: 'component', phase: 'render' }
		],
		phases: [],
		parallelizable: []
	});
	it('merges one owner’s consecutive segments and carries running totals', () => {
		const out = render_steps(tl())!;
		expect(out.steps.map((s) => s.label)).toEqual(['load', 'GET api/items', 'Page', 'Card']);
		expect(out.steps[1].kind).toBe('wait');
		expect(out.steps[1].within).toBe('db');
		expect(out.steps[1].calls).toEqual([{ label: 'GET api/items', ms: 40 }]);
		expect(out.steps[2].ms).toBe(20.5);
		expect(out.steps[2].detail).toBe('escape_html');
		expect(out.steps[2].at_ms).toBe(70.5);
		expect(out.steps[2].cpu_so_far_ms).toBe(30.5);
		expect(out.steps[3].cpu_so_far_ms).toBe(60);
		expect(out.longest).toBe(1);
		expect(out.cpu_ms).toBe(60);
		expect(out.wait_ms).toBe(40);
	});
	it('folds the smallest steps under the cap and takes the stack from the index', () => {
		const t = tl();
		for (let i = 0; i < 50; i++) t.segments.push({ t0: 100 + i, t1: 101 + i, kind: 'cpu', label: `f${i}`, category: 'app', phase: 'render' });
		t.window_ms = 150;
		const out = render_steps(t, undefined, 10)!;
		expect(out.steps.length).toBe(10);
		expect(out.steps.reduce((n, s) => n + 1 + (s.folded ?? 0), 0)).toBe(54);
		const a = analyze(profile(), undefined, undefined, { perf_start: 100, window: { start: 100, end: 110 }, calls: [] });
		const with_stack = render_steps({ ...tl(), window_ms: 10, segments: [{ t0: 3, t1: 7, kind: 'cpu', label: 'Page', category: 'component', phase: 'render' }] }, a.stacks)!;
		expect(with_stack.steps[0].stack).toEqual(['Page', 'Card']);
	});
});

describe('values, not just functions', () => {
	const span = (name: string, ms: number, attrs: Record<string, number | string>): SpanRecord => ({ id: 0, name, start: 0, ms, attrs, route: null, path: null });
	it('ranges each numeric attribute and fits the time against it', () => {
		const rows = span_values([span('ds.render', 10, { tags: 100 }), span('ds.render', 20, { tags: 200 }), span('ds.render', 30, { tags: 300 }), span('ds.render', 41, { tags: 400, variant: 'fast' }), span('other', 5, { n: 1 })]);
		const r = rows.find((x) => x.span === 'ds.render' && x.attr === 'tags')!;
		expect(r.n).toBe(4);
		expect(r.min).toBe(100);
		expect(r.max).toBe(400);
		expect(r.p50).toBe(300);
		expect(r.sum).toBe(1000);
		expect(r.ms_per_unit).toBeCloseTo(0.103, 2);
		expect(r.r).toBeGreaterThan(0.99);
		// a string attribute is not a value row; a single span has no fit
		expect(rows.find((x) => x.attr === 'variant')).toBeUndefined();
		expect(rows.find((x) => x.span === 'other')!.ms_per_unit).toBeUndefined();
	});
	it('skips a constant value, an open span, and no spans', () => {
		expect(span_values(undefined)).toEqual([]);
		const rows = span_values([span('a', 1, { k: 5 }), span('a', 2, { k: 5 }), span('a', 3, { k: 5 }), span('a', -1, { k: 9 })]);
		expect(rows[0].n).toBe(3);
		expect(rows[0].ms_per_unit).toBeUndefined();
		// a spread under 5% of the value is noise, not a slope (three renders of one 2.7 MB document)
		const narrow = span_values([span('p', 300, { bytes: 2_734_413 }), span('p', 290, { bytes: 2_734_417 }), span('p', 280, { bytes: 2_734_422 })]);
		expect(narrow[0].ms_per_unit).toBeUndefined();
	});
});
