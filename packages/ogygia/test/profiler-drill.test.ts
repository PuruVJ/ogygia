import { describe, expect, it } from 'vitest';
import { build_drill, call_group, tag_fills, type DrillNode } from '../src/profiler/drill.js';
import { owner_of_stack, type Timeline } from '../src/profiler/timeline.js';
import type { LedgerLine } from '../src/profiler/ledger.js';
import { drill_deltas, order_of } from '../src/profiler/compare.js';

// One render's time as a tree that adds up at every level: phase → who held it → the line.

const seg = (
	o: Partial<Timeline['segments'][number]> &
		Pick<Timeline['segments'][number], 't0' | 't1' | 'kind' | 'label'>
) => ({ category: 'app', phase: 'load', ...o }) as Timeline['segments'][number];

const line = (o: Partial<LedgerLine> & Pick<LedgerLine, 'file' | 'line'>): LedgerLine =>
	({
		path: '/app/' + o.file,
		cpu_ms: 0,
		alloc_bytes: 0,
		gc_ms: 0,
		retained_bytes: 0,
		who: [],
		lib_ms: 0,
		score: 0,
		...o
	}) as LedgerLine;

const sum = (n: DrillNode) =>
	Math.round((n.children ?? []).reduce((s, c) => s + c.ms, 0) * 100) / 100;

describe('drill_deltas', () => {
	const tree = (product: number, other: number, folded = false): DrillNode => ({
		label: 'render',
		ms: product + other,
		kind: 'render',
		children: [
			{
				label: 'load functions',
				ms: product + other,
				kind: 'phase',
				children: [
					{
						label: 'GET api/product/:id',
						ms: product,
						kind: 'wait',
						children: [{ label: 'fetchStock (x.ts:25)', ms: product, kind: 'line', at: 'x.ts:25' }]
					},
					...(folded
						? [{ label: '3 more', ms: other, kind: 'more' as const }]
						: [{ label: 'GET api/nav', ms: other, kind: 'wait' as const }])
				]
			}
		]
	});

	it('names the deepest row that moved, not every level above it', () => {
		const d = drill_deltas(tree(100, 10), tree(12, 10));
		expect(d).toEqual([
			{
				path: ['load functions', 'GET api/product/:id', 'fetchStock (x.ts:25)'],
				kind: 'line',
				at: 'x.ts:25',
				a_ms: 100,
				b_ms: 12,
				d_ms: -88,
				waiting: true,
				status: 'better'
			}
		]);
	});

	it('a line renumbered by an edit above it is the same line, not one fixed and one new', () => {
		const t = (line: number, ms: number): DrillNode => ({
			label: 'render',
			ms,
			kind: 'render',
			children: [
				{
					label: 'load functions',
					ms,
					kind: 'phase',
					children: [
						{
							label: 'load',
							ms,
							kind: 'cpu',
							children: [{ label: `x.ts:${line}`, ms, kind: 'line', at: `x.ts:${line}` }]
						}
					]
				}
			]
		});
		expect(drill_deltas(t(108, 68), t(109, 70))).toEqual([]);
		// a line whose cost really went: still fixed
		expect(
			drill_deltas(t(108, 68), t(109, 10))
				.map((d) => d.status)
				.sort()
		).toEqual(['fixed', 'new']);
	});

	it('with the code on both sides: the same code is one line (its own change kept); other code is a fix and a new cost', () => {
		type L = { line: number; ms: number; code: string };
		const t = (...ls: L[]): DrillNode => {
			const ms = ls.reduce((s, l) => s + l.ms, 0);
			return {
				label: 'render',
				ms,
				kind: 'render',
				children: [
					{
						label: 'load functions',
						ms,
						kind: 'phase',
						children: [
							{
								label: 'load',
								ms,
								kind: 'cpu',
								children: ls.map((l) => ({
									label: `x.ts:${l.line}`,
									ms: l.ms,
									kind: 'line' as const,
									at: `x.ts:${l.line}`,
									code: l.code
								}))
							}
						]
					}
				]
			};
		};
		// renumbered AND slower: one row, worse, at its new place
		expect(
			drill_deltas(
				t({ line: 108, ms: 30, code: 'const v = validate(P);' }),
				t({ line: 112, ms: 60, code: 'const v = validate(P);' })
			)
		).toMatchObject([
			{ path: ['load functions', 'load', 'x.ts:112'], a_ms: 30, b_ms: 60, status: 'worse' }
		]);
		// a line fixed while an unrelated one nearby costs about the same: not hidden as a move
		const fixed_and_new = drill_deltas(
			t({ line: 108, ms: 30, code: 'const v = validate(P);' }),
			t({ line: 110, ms: 31, code: 'const r = rank(v);' })
		);
		expect(fixed_and_new.map((d) => d.status).sort()).toEqual(['fixed', 'new']);
		// two candidates of the same code: the closest one
		const two = drill_deltas(
			t({ line: 100, ms: 20, code: 'x();' }, { line: 140, ms: 5, code: 'y();' }),
			t(
				{ line: 103, ms: 20, code: 'x();' },
				{ line: 130, ms: 20, code: 'x();' },
				{ line: 141, ms: 5, code: 'y();' }
			)
		);
		expect(two).toMatchObject([{ path: ['load functions', 'load', 'x.ts:130'], status: 'new' }]);
	});

	it("a moved line's parent is weighed against the pair: its own move is not lost", () => {
		const t = (at: number, line_ms: number, own: number): DrillNode => ({
			label: 'render',
			ms: line_ms + own,
			kind: 'render',
			children: [
				{
					label: 'load functions',
					ms: line_ms + own,
					kind: 'phase',
					children: [
						{
							label: 'load',
							ms: line_ms + own,
							kind: 'cpu',
							children: [
								{ label: `x.ts:${at}`, ms: line_ms, kind: 'line', at: `x.ts:${at}`, code: 'a();' },
								{ label: '1 more', ms: own, kind: 'more' }
							]
						}
					]
				}
			]
		});
		// the line moved (same cost); the function's other time grew 10 → 40
		const d = drill_deltas(t(10, 50, 10), t(14, 50, 40));
		expect(d.find((x) => x.path.join('/') === 'load functions/load')).toMatchObject({
			a_ms: 60,
			b_ms: 90,
			status: 'worse'
		});
		expect(d.some((x) => x.kind === 'line')).toBe(false);
	});

	it("with both sides' spreads over renders, a move is ranges that do not overlap", () => {
		const t = (ms: number, runs: [number, number]): DrillNode => ({
			label: 'render',
			ms,
			kind: 'render',
			children: [
				{
					label: 'hooks',
					ms,
					kind: 'phase',
					children: [{ label: 'render2', ms, kind: 'cpu', runs }]
				}
			]
		});
		// 30 → 38, but the renders spread 26–40 and 33–41: noise, though over the 20 % rule
		expect(drill_deltas(t(30, [26, 40]), t(38, [33, 41]))).toEqual([]);
		// 30 → 34 in tight ranges (29–31, 33–35): a real move, though under 20 %
		expect(drill_deltas(t(30, [29, 31]), t(34, [33, 35]))[0]).toMatchObject({
			path: ['hooks', 'render2'],
			d_ms: 4,
			status: 'worse'
		});
	});

	it('a row folded into "N more" on one side is never called fixed: it is at most the fold; small moves are noise', () => {
		// the fold is as big as the row was: it may just sit in there
		expect(drill_deltas(tree(100, 10), tree(100, 9, true))).toEqual([]);
		// a fold of 3 ms: the row is 3 ms at most, a move of at least 7
		expect(drill_deltas(tree(100, 10), tree(100, 3, true))).toEqual([
			{
				path: ['load functions', 'GET api/nav'],
				kind: 'wait',
				a_ms: 10,
				b_ms: 3,
				d_ms: -7,
				upto: 'b',
				waiting: true,
				status: 'better'
			}
		]);
		expect(drill_deltas(tree(100, 10), tree(101.5, 10))).toEqual([]);
	});
});

describe('order_of', () => {
	const meta = (created: number, age_s: number, requests_before: number) =>
		({ created, instance: { first_request_ms: 0, node_ms: 0, age_s, requests_before } }) as never;
	const leak = [{ kind: 'kept-per-render', kept_bytes: 60 * 1048576 }] as never;

	it('warns when the later report ran on the heap an earlier leaky one filled, on the same server', () => {
		const a = { meta: meta(1_000_000, 100, 5), patterns: leak };
		const b = { meta: meta(1_020_000, 120, 30) };
		expect(order_of(a, b)).toEqual({ earlier: 'a', kept_mb: 60, requests_between: 25 });
		// the leaky one second: nothing inherited its heap
		expect(order_of({ ...a, patterns: undefined }, { ...b, patterns: leak })).toBeUndefined();
	});

	it('no warning across servers (a restart between them)', () => {
		expect(
			order_of({ meta: meta(1_000_000, 100, 5), patterns: leak }, { meta: meta(1_020_000, 3, 2) })
		).toBeUndefined();
	});
});

describe('drill: the review cases', () => {
	it('v2 is a word, P12 an id', () => {
		expect(call_group('GET host/api/v2/users/P12')).toBe('GET host/api/v2/users/:id');
	});

	it('identical calls from one line are each a call', () => {
		const calls = Array.from({ length: 4 }, (_, i) => ({
			label: 'GET api/config',
			ms: 5 + i * 0.01,
			caller: 'load (x.ts:3)'
		}));
		const t = {
			segments: calls.map((c, i) =>
				seg({ t0: i * 5, t1: i * 5 + 5, kind: 'wait', label: c.label, calls: [c] })
			)
		} as unknown as Timeline;
		expect(build_drill(t)!.children![0].children![0].calls).toBe(4);
	});

	it('a line folded into "N more" still speaks for its row\'s keys; a CPU row reads its lines, not its function\'s start', () => {
		const row: DrillNode = {
			label: 'GET api/x',
			ms: 10,
			kind: 'wait',
			children: [
				{ label: 'a', ms: 9, kind: 'line', at: 'routes/x/+page.server.ts:5' },
				{
					label: '1 more',
					ms: 1,
					kind: 'more',
					children: [{ label: 'b', ms: 1, kind: 'line', at: 'routes/x/+page.server.ts:9' }]
				}
			]
		};
		const cpu: DrillNode = {
			label: 'load',
			ms: 10,
			kind: 'cpu',
			at: 'routes/x/+page.server.ts:1',
			children: [{ label: 'l', ms: 10, kind: 'line', at: 'routes/x/+page.server.ts:7' }]
		};
		const root: DrillNode = {
			label: 'render',
			ms: 20,
			kind: 'render',
			children: [{ label: 'load functions', ms: 20, kind: 'phase', children: [row, cpu] }]
		};
		tag_fills(root, [
			{ key: 'dead', from: 'routes/x/+page.server.ts', lines: [5], verdict: 'unread' },
			{ key: 'live', from: 'routes/x/+page.server.ts', lines: [9, 7], verdict: 'server' }
		]);
		// the folded line 9 feeds a read key: the row is not "nothing reads it"
		expect(row.fills).toEqual([
			{ key: 'dead', read: false },
			{ key: 'live', read: true }
		]);
		expect(cpu.fills).toEqual([{ key: 'live', read: true }]);
	});
});

describe('owner_of_stack', () => {
	const f = (name: string, url: string, line: number, category: string, pkg?: string) =>
		({ name, url, line, category, ...(pkg ? { pkg } : {}) }) as never;
	it('with no named frame of yours, it names the place: a module loading, or a nameless callback', () => {
		expect(
			owner_of_stack([
				f('push', '', 0, 'v8'),
				f('(anonymous)', '/app/src/lib/catalog.ts', 1, 'app')
			]).label
		).toBe('module load (app/src/lib/catalog.ts)');
		expect(owner_of_stack([f('(anonymous)', '/app/src/lib/catalog.ts', 40, 'app')]).label).toBe(
			'fn @ app/src/lib/catalog.ts:40'
		);
		// a named frame of yours still wins
		expect(
			owner_of_stack([
				f('(anonymous)', '/app/src/lib/a.ts', 9, 'app'),
				f('load', '/app/src/routes/+page.server.ts', 3, 'app')
			]).label
		).toBe('load');
		// a library's nameless top level groups with its package
		expect(
			owner_of_stack([f('', '/app/node_modules/dslib/index.mjs', 1, 'dependency', 'dslib')]).label
		).toBe('module load (dslib)');
	});
});

describe('build_drill', () => {
	const tl = {
		segments: [
			// two product ids waited on together, then one more, all from one line
			seg({
				t0: 0,
				t1: 10,
				kind: 'wait',
				label: '2 calls in parallel',
				calls: [
					{ label: 'GET api/product/P1', ms: 10, caller: 'fetchStock (routes/+page.server.ts:25)' },
					{ label: 'GET api/product/P2', ms: 10, caller: 'fetchStock (routes/+page.server.ts:25)' }
				]
			}),
			seg({
				t0: 10,
				t1: 16,
				kind: 'wait',
				label: 'GET api/product/P3',
				calls: [
					{ label: 'GET api/product/P3', ms: 6, caller: 'fetchStock (routes/+page.server.ts:25)' }
				]
			}),
			// a library's CPU in the hooks, and your function
			seg({
				t0: 16,
				t1: 46,
				kind: 'cpu',
				label: 'render2 (dslib)',
				category: 'dependency',
				phase: 'hooks',
				file: 'dslib/index.mjs:9'
			}),
			seg({
				t0: 46,
				t1: 56,
				kind: 'cpu',
				label: 'splice',
				phase: 'hooks',
				file: 'src/lib/ds.ts:60'
			}),
			// the profiler's own work never shows
			seg({
				t0: 56,
				t1: 60,
				kind: 'cpu',
				label: 'profiler overhead',
				category: 'profiler',
				phase: 'other'
			})
		]
	} as unknown as Timeline;
	const ledger = [
		line({
			file: 'src/lib/ds.ts',
			line: 17,
			lib_ms: 90,
			libs: [{ name: 'render2', pkg: 'dslib', ms: 90 }]
		}),
		line({ file: 'src/lib/ds.ts', line: 64, cpu_ms: 30, fn: 'splice /app/src/lib/ds.ts' }),
		line({ file: 'src/lib/ds.ts', line: 66, cpu_ms: 10, fn: 'splice /app/src/lib/ds.ts' })
	];
	const root = build_drill(tl, ledger)!;

	it('adds up at every level, and leaves the profiler out', () => {
		expect(root.ms).toBe(56);
		expect(sum(root)).toBe(56);
		for (const p of root.children!) expect(sum(p)).toBe(p.ms);
	});

	it('the load phase splits by load file; ids of one endpoint are one wait row, shared waits split, rooted at the calling line', () => {
		const load = root.children!.find((c) => c.label === 'load functions')!;
		expect(load.children).toEqual([
			{
				label: 'routes/+page.server.ts',
				ms: 16,
				kind: 'lane',
				at: 'routes/+page.server.ts',
				children: [
					{
						label: 'GET api/product/:id',
						ms: 16,
						kind: 'wait',
						calls: 3,
						alone: 16,
						split: { calls: 3, network_ms: 26, body_ms: 0 },
						children: [
							{
								label: 'fetchStock (routes/+page.server.ts:25)',
								ms: 16,
								kind: 'line',
								at: 'routes/+page.server.ts:25'
							}
						]
					}
				]
			}
		]);
	});

	it('a library roots in your line that calls it; your function in its lines', () => {
		const hooks = root.children!.find((c) => c.label === 'hooks')!;
		const lib = hooks.children!.find((c) => c.label === 'dslib')!;
		expect(lib).toMatchObject({ ms: 30, kind: 'cpu', at: 'src/lib/ds.ts:17' });
		const fn = hooks.children!.find((c) => c.label === 'splice')!;
		expect(fn.children!.map((c) => [c.at, c.ms])).toEqual([
			['src/lib/ds.ts:64', 7.5],
			['src/lib/ds.ts:66', 2.5]
		]);
	});

	it('a CPU owner that is one row carries its low–high over the renders', () => {
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 30,
					kind: 'cpu',
					label: 'render2 (dslib)',
					category: 'dependency',
					phase: 'hooks',
					file: 'dslib/a.js:1'
				})
			]
		} as unknown as Timeline;
		const row = build_drill(t, [], [], [], new Map(), { dslib: [31, 28, 35] })!.children![0]
			.children![0];
		expect(row).toMatchObject({ label: 'dslib', runs: [28, 35] });
		// its cold first render, when it stands out (≥ 1.5× its slowest warm one and 5 ms more)
		const cold = (ms: number) =>
			build_drill(t, [], [], [], new Map(), { dslib: [31, 28, 35] }, new Map([['dslib', ms]]))!
				.children![0].children![0].cold;
		expect(cold(120)).toBe(120);
		expect(cold(40)).toBeUndefined();
	});

	it("a wait row carries its endpoint's waiting over the renders", () => {
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 30,
					kind: 'wait',
					label: 'GET api/p/P1',
					calls: [{ label: 'GET api/p/P1', ms: 30 }]
				})
			]
		} as unknown as Timeline;
		const row = build_drill(t, [], [], [], new Map(), {}, new Map(), {
			'GET api/p/:id': [31, 44, 29]
		})!.children![0].children![0];
		expect(row).toMatchObject({ label: 'GET api/p/:id', kind: 'wait', runs: [29, 44] });
	});

	it('a component row carries its render count, and "renders per item" when that pattern names it', () => {
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 30,
					kind: 'cpu',
					label: 'ResultCard',
					category: 'component',
					phase: 'render',
					file: 'src/lib/ResultCard.svelte:1'
				})
			]
		} as unknown as Timeline;
		const row = build_drill(
			t,
			[],
			[
				{
					kind: 'render-per-item',
					sites: [
						{
							file: 'routes/+page.svelte',
							path: 'routes/+page.svelte',
							line: 19,
							fn_name: 'ResultCard'
						}
					] as never
				}
			],
			[],
			new Map([['ResultCard', 120]])
		)!.children![0].children![0];
		expect(row).toMatchObject({ label: 'ResultCard', calls: 120, why: ['render-per-item'] });
	});

	it('the rows an "N more" folds stay inside it, adding up to it', () => {
		const t = {
			segments: Array.from({ length: 9 }, (_, i) =>
				seg({
					t0: i * 10,
					t1: i * 10 + 10 - i,
					kind: 'cpu',
					label: `fn${i}`,
					phase: 'hooks',
					file: `src/lib/a.ts:${i + 1}`
				})
			)
		} as unknown as Timeline;
		const hooks = build_drill(t)!.children![0];
		const more = hooks.children!.find((c) => c.kind === 'more')!;
		// (fn6 still shows: folding it too would hide over a tenth of the phase)
		expect(more.children!.map((c) => c.label)).toEqual(['fn7', 'fn8']);
		expect(sum(more)).toBe(more.ms);
	});

	it('garbage collection goes to the lines that made the garbage, by the pauses each caused', () => {
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 20,
					kind: 'cpu',
					label: 'garbage collection',
					category: 'gc',
					phase: 'other'
				})
			]
		} as unknown as Timeline;
		const gc = build_drill(
			t,
			[],
			[],
			[
				{
					name: 'replace',
					url: 'node:internal',
					line: 0,
					at: { path: '/app/src/lib/ds.ts', line: 64 },
					gc_ms: 30
				},
				{ name: 'map', url: '/app/src/lib/view.ts', line: 9, gc_ms: 10 },
				{
					name: 'slice',
					url: '/app/src/lib/ds.ts',
					line: 1,
					at: { path: '/app/src/lib/ds.ts', line: 64 },
					gc_ms: 0
				}
			]
		)!.children![0].children![0];
		expect(gc.children!.map((c) => [c.at, c.ms])).toEqual([
			['src/lib/ds.ts:64', 15],
			['src/lib/view.ts:9', 5]
		]);
	});

	it('a gap with a queued callback takes the line that queued it, and its load file', () => {
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 9,
					kind: 'gap',
					label: 'nothing recorded — pending: Immediate from routes/shop/+page.server.ts:52',
					category: 'unknown',
					pending: ['Immediate from routes/shop/+page.server.ts:52']
				})
			]
		} as unknown as Timeline;
		const d = build_drill(
			t,
			[],
			[
				{
					kind: 'yield-per-item',
					sites: [
						{
							file: 'routes/shop/+page.server.ts',
							path: '/app/src/routes/shop/+page.server.ts',
							line: 52
						}
					] as never
				}
			]
		)!;
		const lane = d.children![0].children![0];
		expect(lane).toMatchObject({ label: 'routes/shop/+page.server.ts', kind: 'lane' });
		expect(lane.children![0]).toMatchObject({
			kind: 'gap',
			at: 'routes/shop/+page.server.ts:52',
			why: ['yield-per-item']
		});
	});

	it('a $lib helper a load ran sits under that load file (its stack says so), not loose in the phase', () => {
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 10,
					kind: 'cpu',
					label: 'attachBrands',
					file: 'src/lib/catalog.ts:13',
					lane: 'routes/shop/+page.server.ts'
				}),
				seg({
					t0: 10,
					t1: 14,
					kind: 'cpu',
					label: 'load',
					file: 'src/routes/shop/+page.server.ts:60'
				})
			]
		} as unknown as Timeline;
		const load = build_drill(t)!.children![0];
		expect(load.children!.map((c) => [c.label, c.ms, c.children?.map((k) => k.label)])).toEqual([
			['routes/shop/+page.server.ts', 14, ['attachBrands', 'load']]
		]);
	});

	it("a package called from one line of yours splits into the package's own functions", () => {
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 20,
					kind: 'cpu',
					label: 'getNamedItem (dslib)',
					category: 'dependency',
					phase: 'hooks',
					file: 'dslib/index.mjs:40'
				}),
				seg({
					t0: 20,
					t1: 25,
					kind: 'cpu',
					label: 'computeMode (dslib)',
					category: 'dependency',
					phase: 'hooks',
					file: 'dslib/index.mjs:9'
				}),
				seg({
					t0: 25,
					t1: 35,
					kind: 'cpu',
					label: 'getNamedItem (dslib)',
					category: 'dependency',
					phase: 'hooks',
					file: 'dslib/index.mjs:40'
				})
			]
		} as unknown as Timeline;
		const lib = build_drill(t, [
			line({
				file: 'src/lib/ds.ts',
				line: 17,
				lib_ms: 90,
				libs: [{ name: 'render2', pkg: 'dslib', ms: 90 }]
			})
		])!.children![0].children![0];
		expect(lib).toMatchObject({ label: 'dslib', ms: 35, at: 'src/lib/ds.ts:17' });
		expect(lib.children!.map((c) => [c.label, c.ms, c.at])).toEqual([
			['getNamedItem', 30, 'dslib/index.mjs:40'],
			['computeMode', 5, 'dslib/index.mjs:9']
		]);
	});

	it("an HTTP wait splits each call's own clock once: their side (Server-Timing, nested entries not double counted), the rest, the body", () => {
		const call = {
			label: 'GET api/session',
			ms: 45,
			body_ms: 5,
			caller: 'x (a.ts:1)',
			timings: [
				{ name: 'ssr', ms: 30, desc: 'render' },
				{ name: 'db', ms: 21, desc: 'postgres' }
			]
		};
		const t = {
			segments: [
				// one call seen across two segments: counted once
				seg({ t0: 0, t1: 20, kind: 'wait', label: 'GET api/session', calls: [call] }),
				seg({ t0: 21, t1: 46, kind: 'wait', label: 'GET api/session', calls: [call] }),
				seg({ t0: 46, t1: 50, kind: 'wait', label: 'timer', calls: [{ label: 'timer', ms: 4 }] })
			]
		} as unknown as Timeline;
		const rows = build_drill(t)!.children![0].children!;
		// 40 ms until headers; their entries sum to 51 > 40, so they nest: the largest (30) is theirs
		expect(rows.find((r) => r.label === 'GET api/session')!.split).toEqual({
			calls: 1,
			theirs_ms: 30,
			told: 1,
			network_ms: 10,
			body_ms: 5,
			top: [
				{ name: 'render', ms: 30 },
				{ name: 'postgres', ms: 21 }
			]
		});
		expect(rows.find((r) => r.label === 'timer')!.split).toBeUndefined();
	});

	it('a wait row knows how long it held the render alone: with other endpoints in flight it did not', () => {
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 10,
					kind: 'wait',
					label: '2 calls in parallel',
					calls: [
						{ label: 'GET api/a', ms: 10 },
						{ label: 'GET api/b', ms: 10 }
					]
				}),
				seg({
					t0: 10,
					t1: 16,
					kind: 'wait',
					label: 'GET api/a',
					calls: [{ label: 'GET api/a', ms: 6 }]
				})
			]
		} as unknown as Timeline;
		const rows = build_drill(t)!.children![0].children!;
		expect(rows.find((r) => r.label === 'GET api/a')).toMatchObject({ ms: 11, alone: 6 });
		expect(rows.find((r) => r.label === 'GET api/b')!.alone).toBe(0);
	});

	it("a helper's line goes one level further: the lines of yours that called it", () => {
		const call = (label: string, outer: string) => ({
			label,
			ms: 5,
			caller: 'svc (routes/x.ts:20)',
			callers: ['svc (routes/x.ts:20)', outer, 'fn (output/server/index.js:636)']
		});
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 10,
					kind: 'wait',
					label: '2 calls in parallel',
					calls: [
						call('GET api/user', 'load (routes/x.ts:60)'),
						call('GET api/user', 'load (routes/x.ts:61)')
					]
				}),
				// called straight from the load: the next frame is Kit's, no outer level
				seg({
					t0: 10,
					t1: 14,
					kind: 'wait',
					label: 'GET api/live',
					calls: [
						{
							label: 'GET api/live',
							ms: 4,
							caller: 'load (routes/x.ts:69)',
							callers: ['load (routes/x.ts:69)', 'fn (output/server/index.js:636)']
						}
					]
				})
			]
		} as unknown as Timeline;
		const d = build_drill(t)!;
		const rows = d.children![0].children!;
		const user = rows.find((r) => r.label === 'GET api/user')!;
		expect(user.children![0]).toMatchObject({ at: 'routes/x.ts:20', ms: 10 });
		expect(user.children![0].children!.map((c) => [c.at, c.ms])).toEqual([
			['routes/x.ts:60', 5],
			['routes/x.ts:61', 5]
		]);
		expect(rows.find((r) => r.label === 'GET api/live')!.children![0].children).toBeUndefined();
	});

	it('an owner splits by what its samples ran inside it (its arrows, itself), each by its own lines', () => {
		const t = {
			segments: [
				seg({
					t0: 0,
					t1: 20,
					kind: 'cpu',
					label: 'processTags',
					phase: 'hooks',
					file: 'src/lib/ds.ts:35'
				})
			],
			inner: {
				processTags: [
					{ name: '(anonymous)', file: 'lib/ds.ts:62', ms: 15 },
					{ name: 'processTags', file: 'lib/ds.ts:35', ms: 4 },
					// an arrow with no ledger rows: its own start line
					{ name: '(anonymous)', file: 'lib/ds.ts:48', ms: 1 }
				]
			}
		} as unknown as Timeline;
		const d = build_drill(t, [
			line({
				file: 'src/lib/ds.ts',
				line: 64,
				cpu_ms: 30,
				fn: '(anonymous) /app/src/lib/ds.ts:62'
			}),
			line({ file: 'src/lib/ds.ts', line: 36, cpu_ms: 10, fn: 'processTags /app/src/lib/ds.ts' }),
			line({ file: 'src/lib/ds.ts', line: 37, cpu_ms: 30, fn: 'processTags /app/src/lib/ds.ts' }),
			// another arrow of the same file the owner never ran
			line({ file: 'src/lib/ds.ts', line: 91, cpu_ms: 50, fn: '(anonymous) /app/src/lib/ds.ts:90' })
		])!;
		expect(d.children![0].children![0].children!.map((c) => [c.at, c.ms])).toEqual([
			['src/lib/ds.ts:64', 15],
			['src/lib/ds.ts:37', 3],
			['src/lib/ds.ts:36', 1],
			['lib/ds.ts:48', 1]
		]);
	});

	it('tags each row with the patterns found on its line, however the path is spelled, and lifts them to its parents', () => {
		const site = (file: string, line: number, via?: { file: string; line: number }[]) =>
			({
				file,
				path: '/abs/' + file,
				line,
				...(via ? { via: via.map((v) => ({ ...v, path: '' })) } : {})
			}) as never;
		const tagged = build_drill(tl, ledger, [
			// a site on the calling line of the waits
			{ kind: 'same-answer', sites: [site('routes/+page.server.ts', 25)] },
			// a site in a library, named by the caller line that reached it
			{
				kind: 'library-per-item',
				sites: [site('dslib/index.mjs', 9, [{ file: 'lib/ds.ts', line: 17 }])]
			},
			{ kind: 'string-build', sites: [site('src/lib/ds.ts', 66)] }
		])!;
		const load = tagged.children!.find((c) => c.label === 'load functions')!;
		// phases stay untagged; a lane and a call carry their lines' tags
		expect(load.why).toBeUndefined();
		expect(load.children![0].why).toEqual(['same-answer']);
		expect(load.children![0].children![0].children![0].why).toEqual(['same-answer']);
		const hooks = tagged.children!.find((c) => c.label === 'hooks')!;
		expect(hooks.children!.find((c) => c.label === 'dslib')!.why).toEqual(['library-per-item']);
		const fn = hooks.children!.find((c) => c.label === 'splice')!;
		expect(fn.why).toEqual(['string-build']);
		expect(fn.children!.map((c) => c.why)).toEqual([undefined, ['string-build']]);
		// the untagged tree stays untagged
		expect(JSON.stringify(root)).not.toContain('why');
	});
});
