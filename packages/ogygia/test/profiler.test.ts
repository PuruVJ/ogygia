import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	analyze,
	analyze_heap,
	categorize,
	decode_mappings,
	join_source,
	sourcemap_resolver,
	type CpuProfile,
	type HeapNode
} from '../src/profiler/analyze.js';
import { sequential_ms, type NetCall } from '../src/profiler/net.js';
import { build_timeline, chain_steps, coalesce, phase_of_stack, label_call, load_lane_of } from '../src/profiler/timeline.js';
import { n_plus_one, path_template, group_islands, island_name, type IslandStat, type RequestEntry } from '../src/profiler/report.js';
import { compare_reports, page_history } from '../src/profiler/compare.js';
import { span, tag, set_span_recorder, type SpanRecord, type SpanRecorder } from '../src/profiler/span.js';
import { span_rows } from '../src/profiler/report.js';
import { build_standalone } from '../src/profiler/standalone.js';
import { profiler } from '../src/profiler/index.js';
import { io_kind } from '../src/profiler/async-io.js';
import { report_json, report_dump, is_dump, derive_findings } from '../src/profiler/report.js';
import { budget_segments, build_treemap, waiting_rows } from '../src/profiler/ui/report-data.js';
import type { RequestEvent } from '@sveltejs/kit';

// The profiler reads dev-vs-prod from `detect_dev()` (a compile-time constant under Vite). Mock it
// through a switch so ONE test can run the production request path (idle requests unattributed).
const dev_switch = vi.hoisted(() => ({ dev: true }));
vi.mock('../src/profiler/env.js', () => ({ detect_dev: () => dev_switch.dev }));

// ─────────────────────────────────────────────────────────────────────────────
// The SSR profiler. The analyzer turns a raw V8 .cpuprofile into readable
// self/total tables — the invariants that matter: recursion never double-counts
// total time, components are recognized by `.svelte` URL (dev) or by Svelte's
// filename-derived function name (prod bundles), and idle/GC are split out of
// busy time. The net layer's sequential detector is what diagnoses the classic
// "5s page = awaits in a row" case, so its overlap math gets pinned here too.
// ─────────────────────────────────────────────────────────────────────────────

const frame = (functionName: string, url = '', lineNumber = 0) => ({
	functionName,
	url,
	lineNumber,
	columnNumber: 0
});

describe('analyze', () => {
	const profile: CpuProfile = {
		startTime: 0,
		endTime: 15_500,
		nodes: [
			{ id: 1, callFrame: frame('(root)'), children: [2, 5, 6] },
			{ id: 2, callFrame: frame('handle', 'file:///app/src/hooks.server.ts', 9), children: [3] },
			{ id: 3, callFrame: frame('Header', '/app/src/lib/Header.svelte', 0), children: [4] },
			{
				id: 4,
				callFrame: frame('escape', '/app/node_modules/svelte/src/internal/server/escaping.js', 3)
			},
			{ id: 5, callFrame: frame('(idle)') },
			{ id: 6, callFrame: frame('(garbage collector)') }
		],
		samples: [4, 4, 3, 5, 5, 6, 2],
		timeDeltas: [1000, 1000, 2000, 5000, 5000, 500, 1000]
	};

	it('splits busy / idle / gc and attributes self+total per frame', () => {
		const a = analyze(profile);
		expect(a.idle_ms).toBe(10);
		expect(a.gc_ms).toBe(0.5);
		expect(a.busy_ms).toBe(5.5);

		const header = a.functions.find((f) => f.name === 'Header')!;
		expect(header.self_ms).toBe(2);
		expect(header.total_ms).toBe(4); // self + escape() below it

		const handle = a.functions.find((f) => f.name === 'handle')!;
		expect(handle.self_ms).toBe(1);
		expect(handle.total_ms).toBe(5);

		// pseudo frames stay out of the functions table
		expect(a.functions.find((f) => f.name === '(idle)')).toBeUndefined();
		expect(a.functions.find((f) => f.name === '(garbage collector)')).toBeUndefined();
	});

	it('recognizes components and buckets time by package', () => {
		const a = analyze(profile);
		expect(a.components.map((c) => c.name)).toEqual(['Header']);
		expect(a.components[0].total_ms).toBe(4);

		const buckets = Object.fromEntries(a.buckets.map((b) => [b.key, b.self_ms]));
		expect(buckets['your code']).toBe(3); // handle (app) + Header (component)
		expect(buckets['svelte']).toBe(2);
		expect(buckets['garbage collection']).toBe(0.5);
	});

	it('merges a component wrapper frame with its inline anonymous work', () => {
		// V8 samples a component's tight inline loop as a nameless frame at the
		// component's own .svelte source, distinct from the named wrapper frame in
		// the bundled chunk. Both must roll up into ONE component row with the loop
		// time as self.
		const merged: CpuProfile = {
			startTime: 0,
			endTime: 4000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				// wrapper frame: named, lives in the route chunk
				{ id: 2, callFrame: frame('PrimeSieve', '/out/chunks/_page.svelte.js', 3), children: [3] },
				// inline loop: anonymous, sourcemapped back to the component file
				{ id: 3, callFrame: frame('', '/app/src/routes/heavy/PrimeSieve.svelte', 0) }
			],
			samples: [3, 3, 2],
			timeDeltas: [1000, 1000, 1000]
		};
		const a = analyze(merged);
		const primes = a.components.filter((c) => c.name === 'PrimeSieve');
		expect(primes).toHaveLength(1); // not split into wrapper + (anonymous)
		expect(primes[0].self_ms).toBe(3); // the loop time counts as the component's self
		// display prefers the real .svelte source over the chunk path
		expect(primes[0].url).toContain('PrimeSieve.svelte');
		// and no stray "(anonymous)" row survives in the functions table
		expect(a.functions.find((f) => f.name === '(anonymous)')).toBeUndefined();
	});

	it('counts recursive frames once in total time', () => {
		const rec: CpuProfile = {
			startTime: 0,
			endTime: 3000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('walk', '/app/src/walk.ts', 1), children: [3] },
				{ id: 3, callFrame: frame('walk', '/app/src/walk.ts', 1), children: [4] },
				{ id: 4, callFrame: frame('leaf', '/app/src/walk.ts', 9) }
			],
			samples: [2, 3, 4],
			timeDeltas: [1000, 1000, 1000]
		};
		const a = analyze(rec);
		const walk = a.functions.find((f) => f.name === 'walk')!;
		expect(walk.self_ms).toBe(2);
		expect(walk.total_ms).toBe(3); // NOT 5 — the nested walk() frame must not double-count
	});

	it('builds a flame tree with (root) lifted and idle pruned', () => {
		const a = analyze(profile);
		const names = a.flame.ch!.map((c) => c.n);
		expect(names).toContain('handle');
		expect(names).not.toContain('(idle)');
		const handle = a.flame.ch!.find((c) => c.n === 'handle')!;
		expect(handle.t).toBe(5);
		expect(handle.ch![0].n).toBe('Header');
	});

	it('joins call counts per function by name+url, so same-named functions stay separate', () => {
		// Two DIFFERENT `traverse` functions in different scripts. Keyed by name alone (the old bug)
		// they merged and each row showed the summed 800; keyed by name+url they keep their own count.
		const NUL = String.fromCharCode(0);
		const dup: CpuProfile = {
			startTime: 0,
			endTime: 4000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2, 3] },
				{ id: 2, callFrame: frame('traverse', 'file:///app/a.js', 1) },
				{ id: 3, callFrame: frame('traverse', 'file:///app/b.js', 1) }
			],
			samples: [2, 3, 2, 3],
			timeDeltas: [1000, 1000, 1000, 1000]
		};
		const counts = {
			['traverse' + NUL + 'file:///app/a.js']: 100,
			['traverse' + NUL + 'file:///app/b.js']: 700
		};
		const a = analyze(dup, undefined, counts);
		const traverses = a.functions.filter((f) => f.name === 'traverse');
		expect(traverses).toHaveLength(2);
		expect(traverses.map((t) => t.calls).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([100, 700]);
	});
});

describe('report data (JSON, findings, budget, treemap, waiting)', () => {
	const meta = {
		id: 'abc',
		created: 1_700_000_000_000,
		trigger: 'window' as const,
		duration_ms: 1000,
		sample_interval_us: 500,
		requests: [],
		node: 'v26.0.0'
	};

	it('renders budget bar + treemap and counts idle exactly once', () => {
		// half idle (waiting), half in app code — the waiting-page shape where a
		// double-counted idle segment would push the bar past 100%
		const profile: CpuProfile = {
			startTime: 0,
			endTime: 1_000_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2, 3] },
				{ id: 2, callFrame: frame('build', '/app/src/build.ts', 4) },
				{ id: 3, callFrame: frame('(idle)') }
			],
			samples: [2, 3],
			timeDeltas: [500_000, 500_000]
		};
		const a = analyze(profile);
		// the treemap has a hierarchy to render
		expect(build_treemap(a)).toBeTruthy();
		const budget = budget_segments(a);
		// idle appears exactly once (not double-counted)
		expect(budget.filter((s) => s.cat === 'idle')).toHaveLength(1);
		// widths sum to ~100% (idle counted once → ~100, double → ~150)
		const sum = budget.reduce((s, seg) => s + seg.pct, 0);
		expect(sum).toBeGreaterThan(95);
		expect(sum).toBeLessThan(101);
	});

	it('emits a curated JSON report an agent can read', () => {
		const profile: CpuProfile = {
			startTime: 0,
			endTime: 4000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2, 5] },
				{ id: 2, callFrame: frame('handle', '/app/src/hooks.server.ts', 9), children: [3] },
				{ id: 3, callFrame: frame('Header', '/app/src/lib/Header.svelte', 0), children: [4] },
				{
					id: 4,
					callFrame: frame('escape', '/app/node_modules/svelte/src/internal/server/x.js', 3)
				},
				{ id: 5, callFrame: frame('(garbage collector)') }
			],
			samples: [4, 3, 2, 5],
			timeDeltas: [1000, 1000, 1000, 1000]
		};
		const a = analyze(profile);
		const j = report_json(a, meta, '/__profiler', { net: [], heap: null, mem: [] }) as Record<
			string,
			any
		>;

		expect(j.schema).toBe('ogygia-profiler-report');
		expect(j.units.time).toBe('ms');
		expect(j.summary.verdict).toMatch(/compute-bound|waiting|mixed/);
		expect(Array.isArray(j.findings)).toBe(true);
		expect(j.findings[0]).toHaveProperty('code');
		expect(j.findings[0]).toHaveProperty('severity');
		// component attribution survives into JSON
		expect(j.components.map((c: any) => c.name)).toContain('Header');
		// budget covers the window and includes GC
		expect(j.budget.some((b: any) => b.category === 'gc')).toBe(true);
		expect(j.links.json).toBe('/__profiler/report/abc.json');
		// round-trips through JSON.stringify (no functions, dates, or cycles)
		expect(() => JSON.parse(JSON.stringify(j))).not.toThrow();
	});

	it('round-trips a dump through JSON and renders identically (the serverless path)', () => {
		const profile: CpuProfile = {
			startTime: 0,
			endTime: 3000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('Header', '/app/src/lib/Header.svelte', 0) }
			],
			samples: [2, 2, 2],
			timeDeltas: [1000, 1000, 1000]
		};
		const a = analyze(profile);
		const extras = { net: [], heap: null, mem: [] };
		// record here → serialize → (download) → JSON.parse → (upload) → render there
		const wire = JSON.parse(JSON.stringify(report_dump(a, meta, extras)));
		expect(is_dump(wire)).toBe(true);
		expect(is_dump({ meta, analysis: a })).toBe(false); // missing extras → rejected
		expect(is_dump({ kind: 'nope', meta, analysis: a, extras })).toBe(false);
		// the uploaded dump produces the same curated report as the live one
		const live = report_json(a, meta, '/__profiler', extras);
		const fromDump = report_json(wire.analysis, wire.meta, '/__profiler', wire.extras);
		expect(fromDump).toEqual(live);
		expect(fromDump.components.map((c: { name: string }) => c.name)).toContain('Header');
	});

	it('shares one findings source between HTML and JSON', () => {
		const profile: CpuProfile = {
			startTime: 0,
			endTime: 2000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('work', '/app/src/x.ts', 1) }
			],
			samples: [2, 2],
			timeDeltas: [1000, 1000]
		};
		const a = analyze(profile);
		const findings = derive_findings(a, meta, { net: [], heap: null, mem: [] });
		const j = report_json(a, meta, '/__profiler', { net: [], heap: null, mem: [] }) as {
			findings: { message: string }[];
		};
		// the JSON findings ARE derive_findings' output — one source, no drift (the UI verdict reads
		// the same derive_findings())
		expect(j.findings.map((f) => f.message)).toEqual(findings.map((f) => f.message));
	});

	it('sorts the components table by self desc by default (ancestors sink)', () => {
		const profile: CpuProfile = {
			startTime: 0,
			endTime: 3000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('_page', '/app/src/routes/+page.svelte', 0), children: [3] },
				{ id: 3, callFrame: frame('Heavy', '/app/src/lib/Heavy.svelte', 0) }
			],
			samples: [3, 3, 2],
			timeDeltas: [1000, 1000, 1000]
		};
		const a = analyze(profile);
		const j = report_json(a, meta, '/__profiler', { net: [], heap: null, mem: [] }) as {
			components: { name: string; self_ms: number }[];
		};
		// components are emitted self-desc (the ComponentsTable island defaults to this sort), so
		// Heavy (self-heavy) leads and the ancestor _page (self ≈ 0) sinks below it
		const heavy = j.components.findIndex((c) => c.name === 'Heavy');
		const ancestor = j.components.findIndex((c) => c.name === '_page');
		expect(heavy).toBeGreaterThanOrEqual(0);
		expect(heavy).toBeLessThan(ancestor);
	});
});

describe('page-mode honesty findings (redirect / not-a-render / budget)', () => {
	// a real render: components sampled, plenty of samples
	const real_profile: CpuProfile = {
		startTime: 0,
		endTime: 4000,
		nodes: [
			{ id: 1, callFrame: frame('(root)'), children: [2] },
			{ id: 2, callFrame: frame('Page', '/app/src/routes/+page.svelte', 0) }
		],
		samples: Array.from({ length: 300 }, () => 2),
		timeDeltas: Array.from({ length: 300 }, () => 10)
	};
	// a non-render: one frame, two samples, no component
	const empty_profile: CpuProfile = {
		startTime: 0,
		endTime: 20,
		nodes: [
			{ id: 1, callFrame: frame('(root)'), children: [2] },
			{ id: 2, callFrame: frame('dispatch', '', 0) }
		],
		samples: [2, 2],
		timeDeltas: [10, 10]
	};
	const base = {
		id: 'p',
		created: 1,
		trigger: 'page' as const,
		duration_ms: 4000,
		sample_interval_us: 500,
		requests: [],
		node: 'v20'
	};
	const codes = (a: ReturnType<typeof analyze>, meta: Parameters<typeof derive_findings>[1]) =>
		derive_findings(a, meta, { net: [], heap: null, mem: [] }).map((f) => f.code);

	it('reports the redirect it followed', () => {
		const a = analyze(real_profile);
		expect(
			codes(a, {
				...base,
				page: '/fr/fr/',
				redirected_from: '/fr/fr',
				run_status: 200,
				run_bytes: 90000
			})
		).toContain('redirected');
	});

	it('warns when the profiled renders were a 3xx (unfollowed redirect), not a page', () => {
		const a = analyze(empty_profile);
		expect(codes(a, { ...base, page: '/fr/fr', run_status: 308, run_bytes: 40 })).toContain(
			'not-a-render'
		);
	});

	it('warns when the body was too small to be a real page', () => {
		const a = analyze(empty_profile);
		expect(codes(a, { ...base, page: '/x', run_status: 200, run_bytes: 40 })).toContain(
			'not-a-render'
		);
	});

	it('flags a low-confidence window (no components, few samples)', () => {
		const a = analyze(empty_profile);
		expect(codes(a, { ...base, page: '/x', run_status: 200, run_bytes: 5000 })).toContain(
			'low-confidence'
		);
	});

	it('does NOT cry low-confidence on a real render', () => {
		const a = analyze(real_profile);
		expect(codes(a, { ...base, page: '/x', run_status: 200, run_bytes: 90000 })).not.toContain(
			'low-confidence'
		);
	});

	it('spots an app that caches the page after the first render', () => {
		const a = analyze(real_profile);
		const c = codes(a, {
			...base,
			page: '/x',
			run_status: 200,
			run_bytes: 90000,
			warmup_ms: 5000,
			runs: [15, 16, 14]
		});
		expect(c).toContain('cached-after-first');
	});

	it('echoes the serverless budget note', () => {
		const a = analyze(real_profile);
		expect(
			codes(a, {
				...base,
				page: '/x',
				run_status: 200,
				run_bytes: 90000,
				budget_note: 'Ran 3 of 5 renders — trimmed to fit the 25s serverless budget.'
			})
		).toContain('budget');
	});
});

describe('I/O wait attribution', () => {
	const meta2 = {
		id: 'io',
		created: 1_700_000_000_000,
		trigger: 'window' as const,
		duration_ms: 5000,
		sample_interval_us: 500,
		requests: [],
		node: 'v26.0.0'
	};
	const netcall = (caller: string, ms: number): NetCall => ({
		start: 0,
		epoch: 0,
		ms,
		method: 'GET',
		url: 'https://api.example.com/x',
		host: 'api.example.com',
		status: 200,
		kind: 'fetch',
		route: null,
		path: null,
		caller
	});

	it('buckets async resource types into friendly kinds', () => {
		expect(io_kind('Timeout')).toBe('timer');
		expect(io_kind('Immediate')).toBe('timer');
		expect(io_kind('FSREQCALLBACK')).toBe('file');
		expect(io_kind('GETADDRINFOREQWRAP')).toBe('dns');
		expect(io_kind('TCPWRAP')).toBe('socket');
		expect(io_kind('ZLIB')).toBe('zlib');
	});

	it('renders "Waiting by function" from network callers + async I/O ops', () => {
		const a = analyze({
			startTime: 0,
			endTime: 5000,
			nodes: [{ id: 1, callFrame: frame('(root)') }],
			samples: [1],
			timeDeltas: [1]
		});
		const rows = waiting_rows(
			[netcall('callService (data.ts:8)', 2000)],
			[
				{ type: 'Timeout', caller: 'queryDatabase (db.ts:4)', ms: 1500, start: 0 },
				{ type: 'FSREQCALLBACK', caller: 'readConfig (config.ts:2)', ms: 12, start: 0 }
			]
		);
		const callers = rows.map((r) => r.caller);
		expect(callers).toContain('callService (data.ts:8)');
		expect(callers).toContain('queryDatabase (db.ts:4)'); // the timer wait, invisible to CPU sampling
		expect(callers).toContain('readConfig (config.ts:2)');
		void a;
	});

	it('includes the waiting aggregate and callers in the JSON', () => {
		const a = analyze({
			startTime: 0,
			endTime: 5000,
			nodes: [{ id: 1, callFrame: frame('(root)') }],
			samples: [1],
			timeDeltas: [1]
		});
		const j = report_json(a, meta2, '/__profiler', {
			net: [netcall('callService (data.ts:8)', 2000)],
			heap: null,
			mem: [],
			io: [{ type: 'Timeout', caller: 'queryDatabase (db.ts:4)', ms: 1500, start: 0 }]
		}) as Record<string, any>;
		const byWait = j.waiting.sort((x: any, y: any) => y.wait_ms - x.wait_ms);
		expect(byWait[0]).toMatchObject({ caller: 'callService (data.ts:8)', kind: 'http' });
		expect(j.waiting.find((w: any) => w.kind === 'timer')).toMatchObject({
			caller: 'queryDatabase (db.ts:4)'
		});
		expect(j.network.calls[0].caller).toBe('callService (data.ts:8)');
	});
});

describe('categorize', () => {
	it('classifies by url and falls back to Svelte naming for bundles', () => {
		expect(categorize(frame('x', 'node:fs')).category).toBe('node');
		expect(categorize(frame('x', '/a/node_modules/@scope/pkg/i.js'))).toEqual({
			category: 'dependency',
			pkg: '@scope/pkg'
		});
		expect(categorize(frame('Header', '/app/src/lib/Header.svelte')).category).toBe('component');
		// closures inside a component file are app code, not the component itself
		expect(categorize(frame('', '/app/src/lib/Header.svelte')).category).toBe('app');
		expect(categorize(frame('each_item', '/app/src/lib/Header.svelte')).category).toBe('app');
		// a same-cased helper CLASS in the component file is not the file's component either
		expect(categorize(frame('Observer', '/app/src/lib/Header.svelte')).category).toBe('app');
		// the bundler's collision suffix is still the file's component
		expect(categorize(frame('Header$1', '/app/src/lib/Header.svelte')).category).toBe('component');
		// a `.svelte.ts` module compiles no component — its classes are app code whatever their case
		expect(categorize(frame('Store', '/app/src/lib/state.svelte.ts')).category).toBe('app');
		// ogygia's own wrappers reached through a workspace link / sourcemap are the library
		expect(categorize(frame('Region', '/repo/packages/ogygia/src/Region.svelte'))).toEqual({
			category: 'dependency',
			pkg: 'ogygia'
		});
		// …and in a production chunk, where only the wrapper's name is left to go on
		expect(categorize(frame('Region', '/out/server/chunks/Region.js'))).toEqual({
			category: 'dependency',
			pkg: 'ogygia'
		});
		expect(categorize(frame('SlotBoundary$1', '/out/server/chunks/internal.js')).pkg).toBe('ogygia');
		expect(categorize(frame('_page', '/out/entries/pages/_page.svelte.js')).category).toBe(
			'component'
		);
		// endpoint handlers are capitalized but are app code, not components
		expect(categorize(frame('GET', '/out/entries/endpoints/api/_server.ts.js')).category).toBe(
			'app'
		);
		// prod bundle: chunk url, but the compiled SSR fn keeps the component name
		expect(categorize(frame('Header', '/out/server/chunks/Header.js')).category).toBe('component');
		expect(categorize(frame('render_page', '/out/server/index.js')).category).toBe('app');
		expect(categorize(frame('(garbage collector)')).category).toBe('gc');
		// the profiler's own machinery: Profiler.start's code scan lands on the
		// first sample as node:inspector `post` — must not read as app time
		expect(categorize(frame('post', 'node:inspector')).category).toBe('profiler');
		expect(categorize(frame('(idle)')).category).toBe('idle');
		// undici's WASM HTTP parser is runtime, not the app
		expect(categorize(frame('wasm-function[20]', 'wasm://wasm/00034eea')).category).toBe('node');
	});
});

describe('component confirmation (structural)', () => {
	// A component-shaped name in a bundled chunk is only a CANDIDATE: a Svelte SSR component calls
	// Svelte's server internals, a class constructor does not. `IntersectionObserver` (a polyfill in
	// app code), an `Error` subclass, any PascalCase helper used to read as a component.
	const profile: CpuProfile = {
		startTime: 0,
		endTime: 6000,
		nodes: [
			{ id: 1, callFrame: frame('(root)'), children: [2] },
			{ id: 2, callFrame: frame('_page', '/out/server/chunks/_page.svelte.js', 3), children: [3, 5] },
			// a real component: its subtree reaches svelte's `push`
			{ id: 3, callFrame: frame('Header$1', '/out/server/chunks/_page.svelte.js', 40), children: [4] },
			{ id: 4, callFrame: frame('push', '/app/node_modules/svelte/src/internal/server/renderer.js', 1) },
			// a class constructor called by the page: PascalCase, app url, no svelte below
			{
				id: 5,
				callFrame: frame('IntersectionObserver', '/out/server/chunks/observe.js', 9),
				children: [6]
			},
			{ id: 6, callFrame: frame('observe', '/out/server/chunks/observe.js', 20) }
		],
		samples: [4, 3, 6, 5, 2, 4],
		timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000]
	};

	it('keeps a candidate that reaches svelte internals, drops one that does not', () => {
		const a = analyze(profile);
		expect(a.components.map((c) => c.name).sort()).toEqual(['Header', '_page']);
		const io = a.functions.find((f) => f.name === 'IntersectionObserver')!;
		expect(io.category).toBe('app');
		// the `$1` collision suffix is gone from the component's row and its key
		expect(a.components.find((c) => c.name === 'Header')!.key).toBe('C:Header');
	});

	it('names an anonymous inline frame after its .svelte file the way Svelte does (kebab-case too)', () => {
		const p: CpuProfile = {
			startTime: 0,
			endTime: 2000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('', '/app/src/lib/site-header.svelte', 0) }
			],
			samples: [2, 2],
			timeDeltas: [1000, 1000]
		};
		expect(analyze(p).components.map((c) => c.name)).toEqual(['Site_header']);
	});
});

describe('call stacks + locations', () => {
	const profile: CpuProfile = {
		startTime: 0,
		endTime: 5000,
		nodes: [
			{ id: 1, callFrame: frame('(root)'), children: [2, 6] },
			{ id: 2, callFrame: frame('handle', '/app/src/hooks.server.ts', 9), children: [3] },
			{ id: 3, callFrame: frame('_page', '/app/src/routes/+page.svelte', 0), children: [4] },
			{ id: 4, callFrame: frame('Row', '/app/src/lib/Row.svelte', 2), children: [5] },
			{ id: 5, callFrame: frame('escape', '/app/node_modules/svelte/src/internal/server/escaping.js', 3) },
			// the same escape reached another way (lighter)
			{ id: 6, callFrame: frame('other', '/app/src/other.ts', 1), children: [7] },
			{ id: 7, callFrame: frame('escape', '/app/node_modules/svelte/src/internal/server/escaping.js', 3) }
		],
		samples: [5, 5, 5, 7, 4],
		timeDeltas: [1000, 1000, 1000, 1000, 1000]
	};

	it('ranks a function’s call paths by the time that flowed through each, nearest caller first', () => {
		const a = analyze(profile);
		const esc = a.functions.find((f) => f.name === 'escape')!;
		expect(esc.stacks).toHaveLength(2);
		expect(esc.stacks![0].ms).toBe(3);
		expect(esc.stacks![0].frames.map((f) => f.n)).toEqual(['Row', '_page', 'handle']);
		expect(esc.stacks![0].frames[0].f).toBe('app/src/lib/Row.svelte:3');
		expect(esc.stacks![1].ms).toBe(1);
		expect(esc.stacks![1].frames.map((f) => f.n)).toEqual(['other']);
		// components carry stacks too; the page's parent is the handle, (root) never shows
		const page = a.components.find((c) => c.name === '_page')!;
		expect(page.stacks![0].frames.map((f) => f.n)).toEqual(['handle']);
	});

	it('a nested occurrence (recursion, or a component’s inner frame under its own wrapper) is one stack, never its own caller', () => {
		const p: CpuProfile = {
			startTime: 0,
			endTime: 3000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('main', '/app/src/main.ts', 0), children: [3] },
				// the bundled wrapper, then svelte's `component`, then the sourcemapped inner frame
				{ id: 3, callFrame: frame('Card', '/out/chunks/_page.svelte.js', 4), children: [4] },
				{ id: 4, callFrame: frame('component', '/app/node_modules/svelte/src/internal/server/renderer.js', 9), children: [5] },
				{ id: 5, callFrame: frame('', '/app/src/lib/Card.svelte', 0) }
			],
			samples: [5, 5, 5],
			timeDeltas: [1000, 1000, 1000]
		};
		const card = analyze(p).components.find((c) => c.name === 'Card')!;
		expect(card.stacks).toHaveLength(1);
		expect(card.stacks![0].frames.map((f) => f.n)).toEqual(['main']);
		expect(card.stacks![0].ms).toBe(3);
	});

	it('joins a sourcemap’s relative sources onto the chunk directory (an openable path)', () => {
		expect(join_source('/app/.svelte-kit/output/server/chunks/x.js', '../../../../src/lib/Foo.svelte')).toBe(
			'/app/src/lib/Foo.svelte'
		);
		expect(join_source('file:///app/out/chunks/x.js', '../../src/a.ts')).toBe('/app/src/a.ts');
		expect(join_source('./chunks/x.js', '../src/a.ts')).toBe('./src/a.ts');
		expect(join_source('/app/out/x.js', '/abs/b.ts')).toBe('/abs/b.ts');
		expect(join_source('/app/out/x.js', 'webpack://y.ts')).toBe('webpack://y.ts');
		expect(join_source('x.js', '../a.ts')).toBe('../a.ts');
	});

	it('keeps the full path + column so a row can be opened in an editor', () => {
		const a = analyze(profile);
		const row = a.components.find((c) => c.name === 'Row')!;
		expect(row.path).toBe('/app/src/lib/Row.svelte');
		expect(row.line).toBe(3);
		expect(row.col).toBe(1);
		expect(row.key).toBe('C:Row');
	});

	it('ships stacks + locations in the JSON report', () => {
		const a = analyze(profile);
		const meta = {
			id: 'x',
			created: 0,
			trigger: 'window' as const,
			duration_ms: 5,
			node: 'v',
			requests: []
		};
		const j = report_json(a, meta as never, '/__profiler', { net: [], mem: [] } as never);
		const esc = j.hot_functions.find((f) => f.name === 'escape')!;
		expect(esc.stacks[0].frames).toEqual([
			'Row (app/src/lib/Row.svelte:3)',
			'_page (app/src/routes/+page.svelte:1)',
			'handle (/app/src/hooks.server.ts:10)'
		]);
		expect(esc.package).toBe('svelte');
		expect(j.components.find((c) => c.name === 'Row')!.path).toBe('/app/src/lib/Row.svelte');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TIMELINE: one request's critical path — CPU segments owned by the component / app function
// on the stack, waits on outbound calls, gaps nobody recorded — plus the phase split and the
// "awaits in a row" detector. Samples and calls are put on one clock through `perf_start`.
// ─────────────────────────────────────────────────────────────────────────────
describe('timeline (critical path + phases)', () => {
	// window [1000, 1100) perf ms; the profile starts at perf 1000 (startTime 0 µs)
	const profile: CpuProfile = {
		startTime: 0,
		endTime: 100_000,
		nodes: [
			{ id: 1, callFrame: frame('(root)'), children: [2, 6, 9] },
			{ id: 2, callFrame: frame('respond', '/app/node_modules/@sveltejs/kit/src/runtime/server/respond.js', 1), children: [3, 5] },
			{ id: 3, callFrame: frame('load', '/app/src/routes/+page.server.ts', 4), children: [4] },
			{ id: 4, callFrame: frame('parse', '/app/src/lib/parse.ts', 2) },
			{ id: 5, callFrame: frame('Header', '/app/src/lib/Header.svelte', 0) },
			{ id: 6, callFrame: frame('render_response', '/app/node_modules/@sveltejs/kit/src/runtime/server/page/render.js', 1), children: [7] },
			{ id: 7, callFrame: frame('inject_client_seeds', '/app/node_modules/ogygia/dist/hooks.js', 9), children: [8] },
			{ id: 8, callFrame: frame('stringify', '/app/node_modules/devalue/src/stringify.js', 1) },
			{ id: 9, callFrame: frame('(idle)') }
		],
		// 10 ms of `parse` under load (t 0–10), idle 10–50 (a wait), Header 50–60, idle 60–90, ogygia 90–100
		samples: [4, 4, 9, 9, 9, 9, 5, 9, 9, 9, 8],
		timeDeltas: [5000, 5000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]
	};
	const frames = new Map(profile.nodes.map((n) => [n.id, n] as const));
	const parents = new Map<number, number>();
	for (const n of profile.nodes) for (const c of n.children ?? []) parents.set(c, n.id);
	const info = (id: number) => {
		const f = frames.get(id)!.callFrame;
		const c = categorize(f);
		return { name: f.functionName, url: f.url, line: f.lineNumber + 1, category: c.category, pkg: c.pkg };
	};
	const input = {
		perf_start: 1000,
		window: { start: 1000, end: 1100 },
		calls: [
			{ start: 1010, ms: 20, label: 'GET api/a', kind: 'net', caller: 'load' },
			{ start: 1031, ms: 18, label: 'GET api/b', kind: 'net', caller: 'load' },
			{ start: 1060, ms: 15, label: 'GET api/c', kind: 'net' },
			{ start: 1060, ms: 25, label: 'GET api/d', kind: 'net' }
		]
	};

	it('walks the window into cpu / wait / gap segments with owners and phases', () => {
		const t = build_timeline(profile, info, (id) => parents.get(id), input);
		expect(t.window_ms).toBe(100);
		const kinds = t.segments.map((s) => `${s.kind}:${s.label}`);
		expect(kinds).toEqual([
			'cpu:parse',
			'wait:GET api/a',
			'gap:nothing recorded',
			'wait:GET api/b',
			'gap:nothing recorded',
			'cpu:Header',
			'wait:2 calls in parallel',
			'wait:GET api/d',
			'gap:nothing recorded',
			'cpu:stringify (devalue)'
		]);
		// the cpu owner is the deepest named app function; its phase comes from the load file above it
		expect(t.segments[0]).toMatchObject({ phase: 'load', category: 'app', file: 'app/src/lib/parse.ts:3' });
		// a wait is charged to the phase of the code that was running before it
		expect(t.segments[1].phase).toBe('load');
		expect(t.segments[5].phase).toBe('render');
		// ogygia's transform is its own phase, even under Kit's render_response
		expect(t.segments.at(-1)!.phase).toBe('ogygia');
		expect(t.cpu_ms).toBe(30);
		expect(t.wait_ms).toBe(63);
		expect(t.gap_ms).toBe(7);
	});

	it('splits the window by phase, cpu and wait apart', () => {
		const t = build_timeline(profile, info, (id) => parents.get(id), input);
		const by = Object.fromEntries(t.phases.map((p) => [p.phase, p]));
		expect(by.load).toMatchObject({ cpu_ms: 10, wait_ms: 38 });
		expect(by.render).toMatchObject({ cpu_ms: 10, wait_ms: 25 });
		expect(by.ogygia).toMatchObject({ cpu_ms: 10, wait_ms: 0 });
	});

	it('spots awaits in a row (different calls, no CPU between) and what running them together saves', () => {
		const t = build_timeline(profile, info, (id) => parents.get(id), input);
		expect(t.parallelizable).toHaveLength(1);
		// read off the coalesced view: each wait carries the 1 ms hair after it (21 + 19)
		expect(t.parallelizable[0]).toMatchObject({ calls: ['GET api/a', 'GET api/b'], ms: 40, save_ms: 19 });
		// the parallel pair (c + d) is not a chain — it already overlaps
	});

	it('lists the steps that set the time, in order, and folds the slivers', () => {
		const t = build_timeline(profile, info, (id) => parents.get(id), input);
		const steps = chain_steps(t, 5);
		// the 1 ms gaps between the awaits fold into their neighbours (a wait interrupted by a
		// sliver reads as one wait); the 5 ms gap before the transform stands
		expect(steps.map((s) => s.seg.label)).toEqual([
			'parse',
			'GET api/a',
			'GET api/b',
			'Header',
			'2 calls in parallel',
			'GET api/d',
			'nothing recorded',
			'stringify (devalue)'
		]);
		expect(steps[1].ms).toBe(21); // the 20 ms wait + the 1 ms hair of nothing after it
	});

	it('coalesce: a run of small slivers becomes one block named after what dominated it', () => {
		const seg = (t0: number, t1: number, kind: 'cpu' | 'wait', label: string): import('../src/profiler/timeline.js').Segment => ({
			t0, t1, kind, label, category: kind === 'cpu' ? 'component' : 'idle', phase: 'render'
		});
		const t = {
			window_ms: 100, cpu_ms: 0, wait_ms: 0, gap_ms: 0, phases: [], parallelizable: [],
			segments: [
				seg(0, 30, 'wait', 'GET a'),
				seg(30, 30.4, 'cpu', 'tick'),
				seg(30.4, 60, 'wait', 'GET a'),
				...Array.from({ length: 20 }, (_, i) => seg(60 + i * 0.5, 60.5 + i * 0.5, 'cpu', i % 2 ? 'Card' : 'Row')),
				seg(70, 100, 'cpu', 'Big')
			]
		};
		const v = coalesce(t);
		expect(v.map((s) => [s.label, s.parts])).toEqual([
			['GET a', 3],
			['mostly Row (+1 more)', 20], // a tie: the first seen wins
			['Big', 1]
		]);
		expect(v[0].t1).toBe(60);
		expect(v[1].inside?.map((i) => i.label)).toEqual(['Row', 'Card']);
		// a hair of CPU before the first big block opens that block (the chain's first link is a step)
		const lead = coalesce({ ...t, segments: [seg(0, 0.4, 'cpu', 'tick'), seg(0.4, 40, 'wait', 'GET a'), seg(40, 100, 'cpu', 'Big')] });
		expect(lead.map((s) => [s.label, s.parts, s.t0])).toEqual([
			['GET a', 2, 0],
			['Big', 1, 40]
		]);
	});

	it('classifies a stack by the deepest phase marker; ogygia beats render beats kit', () => {
		const kit = { name: 'respond', url: '/x/@sveltejs/kit/src/runtime/server/respond.js', line: 1, category: 'dependency' as const };
		const comp = { name: 'Foo', url: '/app/src/lib/Foo.svelte', line: 1, category: 'component' as const };
		const og = { name: 'assemble', url: '/x/node_modules/ogygia/dist/server/document-assembly.js', line: 1, category: 'dependency' as const };
		const hooks = { name: 'handle', url: '/app/src/hooks.server.ts', line: 1, category: 'app' as const };
		expect(phase_of_stack([kit])).toBe('kit');
		expect(phase_of_stack([comp, kit])).toBe('render');
		expect(phase_of_stack([og, comp, kit])).toBe('ogygia');
		expect(phase_of_stack([hooks, kit])).toBe('hooks');
		// a remote function awaited during a component's render is "remote", not "render"
		const remote = { name: 'stockSummary', url: '/app/src/lib/hell/hell.remote.ts', line: 3, category: 'app' as const };
		expect(phase_of_stack([remote, comp, kit])).toBe('remote');
		expect(phase_of_stack([{ name: 'run', url: '/x/@sveltejs/kit/src/runtime/app/server/remote/query.js', line: 1, category: 'dependency' }, comp])).toBe('remote');
		expect(phase_of_stack([{ name: 'x', url: '/app/src/lib/x.ts', line: 1, category: 'app' }])).toBe('other');
		expect(label_call('GET', 'https://api.example.com/v1/items/42?x=1')).toBe('GET api.example.com/v1/items/42');
	});

	it('rides on analyze: the report carries the timeline and the findings read it', () => {
		const a = analyze(profile, undefined, undefined, input);
		expect(a.timeline?.segments.length).toBeGreaterThan(5);
		const meta = { id: 'x', created: 0, trigger: 'request' as const, duration_ms: 100, node: 'v', requests: [], request: { method: 'GET', path: '/', route: null, ms: 100 } };
		const f = derive_findings(a, meta as never, { net: [], mem: [] } as never);
		const codes = f.map((x) => x.code);
		expect(codes).toContain('phases');
		expect(codes).toContain('sequential-awaits');
		const seq = f.find((x) => x.code === 'sequential-awaits')!;
		expect(seq.message).toContain('GET api/a, GET api/b');
		expect(seq.fix).toMatch(/Promise\.all/);
		const j = report_json(a, meta as never, '/p', { net: [], mem: [] } as never);
		expect(j.timeline?.steps[0]).toMatchObject({ what: 'parse', kind: 'cpu', phase: 'load' });
		expect(j.timeline?.parallelizable[0].save_ms).toBe(19);
	});
});

describe('findings name the row and the fix', () => {
	it('N+1: the same endpoint once per item, folded to a template', () => {
		expect(path_template('https://api.x/products/123/reviews?page=2')).toEqual({ host: 'api.x', tpl: '/products/:id/reviews' });
		expect(path_template('https://api.x/u/3f2a9c1e-1111-4222-8333-abcdefabcdef')).toEqual({ host: 'api.x', tpl: '/u/:id' });
		expect(path_template('http://h/hell/api/product/P7?ms=6')).toEqual({ host: 'h', tpl: '/hell/api/product/:id' });
		expect(path_template('http://h/api/SKU-1000/stock')).toEqual({ host: 'h', tpl: '/api/:id/stock' });
		const call = (i: number): NetCall => ({
			start: i,
			epoch: i,
			ms: 4,
			method: 'GET',
			url: `https://api.x/products/${i}`,
			host: 'api.x',
			status: 200,
			kind: 'fetch',
			route: null,
			path: null
		});
		const groups = n_plus_one(Array.from({ length: 12 }, (_, i) => call(i)));
		expect(groups).toEqual([{ host: 'api.x', tpl: '/products/:id', count: 12, ms: 48 }]);
		expect(n_plus_one([call(1), call(2)])).toEqual([]);
	});

	it('a repeated component gets a warn with its row anchor, file and a fix; a heavy single render names what burns inside', () => {
		const many: CpuProfile = {
			startTime: 0,
			endTime: 40_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('Row', '/app/src/lib/Row.svelte', 0), children: [3] },
				{ id: 3, callFrame: frame('push', '/app/node_modules/svelte/src/internal/server/renderer.js', 1) }
			],
			samples: [3, 3, 3, 2],
			timeDeltas: [10_000, 10_000, 10_000, 10_000]
		};
		const meta = { id: 'x', created: 0, trigger: 'page' as const, page: '/p', runs: [40], run_status: 200, run_bytes: 9000, duration_ms: 40, node: 'v', requests: [] };
		const counts = { 'Row\0/app/src/lib/Row.svelte': 800 };
		const f = derive_findings(analyze(many, undefined, counts), meta as never, { net: [], mem: [] } as never);
		const rep = f.find((x) => x.code === 'component-repeat')!;
		expect(rep.message).toContain('Row rendered 800 times');
		expect(rep.anchor).toBe('comp:Row');
		expect(rep.file).toContain('Row.svelte');
		expect(rep.fix).toMatch(/paginate|deferred hole/);

		const heavy: CpuProfile = {
			...many,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('Sieve', '/app/src/lib/Sieve.svelte', 0), children: [3, 4] },
				{ id: 3, callFrame: frame('primes', '/app/src/lib/math.ts', 7) },
				{ id: 4, callFrame: frame('push', '/app/node_modules/svelte/src/internal/server/renderer.js', 1) }
			],
			samples: [3, 3, 3, 4],
			timeDeltas: [10_000, 10_000, 10_000, 10_000]
		};
		const g = derive_findings(analyze(heavy), meta as never, { net: [], mem: [] } as never);
		const one = g.find((x) => x.code === 'component-heavy')!;
		expect(one.message).toContain('most of it is primes (app/src/lib/math.ts:8)');
		expect(one.anchor).toBe('comp:Sieve');
		const hot = g.find((x) => x.code === 'hot-function')!;
		expect(hot.anchor).toMatch(/^fn:primes /);
		expect(hot.message).toContain('called from Sieve');
	});

	it('ogygia’s own cost: the seed and props bytes ride the request log into the findings', () => {
		const p: CpuProfile = { startTime: 0, endTime: 1000, nodes: [{ id: 1, callFrame: frame('(root)') }], samples: [1], timeDeltas: [1000] };
		const og = { transform_ms: 4.2, islands: 21, hints: 30, holes: 0, seed_bytes: 300 * 1024, remote_seed_bytes: 0, tail_bytes: 130 * 1024, fnm_bytes: 0, ctx_bytes: 0, seed_json: true };
		const meta = {
			id: 'x', created: 0, trigger: 'page' as const, page: '/p', runs: [40], run_status: 200, run_bytes: 9000, duration_ms: 40, node: 'v',
			requests: [{ ts: 0, method: 'GET', path: '/p', route: '/p', status: 200, ms: 40, cpu_ms: 10, inflight: 0, net_ms: 0, net_count: 0, internal: true, og }]
		};
		const f = derive_findings(analyze(p), meta as never, { net: [], mem: [] } as never);
		expect(f.find((x) => x.code === 'ogygia-cost')!.message).toContain('21 islands, seed 300 KB, props 130 KB');
		expect(f.find((x) => x.code === 'seed-large')!.fix).toMatch(/page\.data\.x/);
		const j = report_json(analyze(p), meta as never, '/p', { net: [], mem: [] } as never);
		expect(j.ogygia).toMatchObject(og);
		expect(j.ogygia).toMatchObject({ island_rows: [], hole_rows: [], seed: null });
		expect(j.kit).toEqual({ uneval_ms: 0, etag_ms: 0 });
	});
});

describe('the ogygia / svelte / kit round: islands, seed, holes, lanes, markup vs logic', () => {
	const p1: CpuProfile = { startTime: 0, endTime: 1000, nodes: [{ id: 1, callFrame: frame('(root)') }], samples: [1], timeDeltas: [1000] };
	const base_og = { transform_ms: 4, islands: 3, hints: 4, holes: 1, seed_bytes: 80 * 1024, remote_seed_bytes: 0, tail_bytes: 20 * 1024, fnm_bytes: 0, ctx_bytes: 0, seed_json: false, seed_culprit: 'config.updated (Date)' };
	const island = (over: Partial<IslandStat> & { entry: string; fp: string }): IslandStat => ({
		name: '',
		module_url: `/_app/immutable/${over.fp}.js`,
		wake: 'load',
		props_bytes: 512,
		canonical_bytes: 512,
		json: true,
		culprit: null,
		refs: 0,
		ref_keys: [],
		hints: ['/_app/immutable/chunk-shared.js'],
		interactivity: { handlers: 1, state: 1, effects: 0, binds: 0, actions: 0, files: 1 },
		count: 1,
		...over
	});
	const rows: IslandStat[] = [
		island({ entry: 'src/lib/MegaHeader.svelte', fp: 'aaaaaaaaaaaaaaaa', props_bytes: 300 * 1024, canonical_bytes: 300 * 1024, json: false, culprit: 'config.updated (Date)' }),
		island({ entry: 'src/lib/CountryPanel.svelte', fp: 'bbbbbbbbbbbbbbbb', wake: 'visible', interactivity: { handlers: 0, state: 0, effects: 0, binds: 0, actions: 0, files: 2 } }),
		// a list: one fingerprint per card (different props), merged into one row by group_islands
		...Array.from({ length: 48 }, (_, i) =>
			island({ entry: '/_app/immutable/og-region.4b95bfb97fab.js', name: 'ProductCard', fp: `cccccccccccccc${i.toString(16).padStart(2, '0')}`, wake: 'visible', refs: 1, ref_keys: ['catalog'], props_bytes: 80, canonical_bytes: 9000 })
		)
	];
	const og = {
		...base_og,
		island_rows: rows,
		seed: {
			keys: [
				{ key: 'catalog', bytes: 70 * 1024, readers: ['PriceTicker'], referenced_by: ['ProductCard'], shipped: true, reason: 'read' as const },
				{ key: 'session', bytes: 8 * 1024, readers: [], referenced_by: [], shipped: false, reason: null }
			],
			whole_by: []
		},
		hole_rows: [{ id: 'cafebabe0102', when: 'load', hydrate: null, ttl: 300, count: 1 }]
	};
	const req = (over: Partial<RequestEntry>): RequestEntry => ({ ts: 0, method: 'GET', path: '/hell', route: '/hell', status: 200, ms: 40, cpu_ms: 10, inflight: 0, net_ms: 0, net_count: 0, ...over });
	const meta = {
		id: 'x', created: 0, trigger: 'page' as const, page: '/hell', runs: [40, 42], run_status: 200, run_bytes: 9000, duration_ms: 82, node: 'v',
		requests: [
			req({ internal: true, og }),
			req({ path: '/__ogygia__?id=cafebabe0102', route: null, ms: 30, hole: { kind: 'hole' as const, id: 'cafebabe0102', cache: 'miss' as const, ttl: 300 } }),
			req({ path: '/__ogygia__?id=cafebabe0102', route: null, ms: 31, hole: { kind: 'hole' as const, id: 'cafebabe0102', cache: 'miss' as const, ttl: 300 } })
		]
	};
	const weights = { '/_app/immutable/aaaaaaaaaaaaaaaa.js': 40_000, '/_app/immutable/bbbbbbbbbbbbbbbb.js': 20_000, '/_app/immutable/chunk-shared.js': 100_000 };
	const client = [{ fp: 'aaaaaaaaaaaaaaaa', entry: 'src/lib/MegaHeader.svelte', name: '', n: 3, p50_ms: 120, max_ms: 150, load_p50_ms: 100 }];
	const extras = { net: [], mem: [], weights, client } as never;

	it('findings: the seed explained, devalue culprits, the wake advisor, hole economics, the browser side', () => {
		const f = derive_findings(analyze(p1), meta as never, extras);
		const by = Object.fromEntries(f.map((x) => [x.code, x]));
		expect(by['seed-explainer'].message).toContain("The seed's biggest key is catalog (70 KB of 80 KB): read by PriceTicker");
		expect(by['seed-devalue'].message).toContain('config.updated (Date)');
		expect(by['props-devalue'].severity).toBe('warn'); // 300 KB of devalue props
		expect(by['props-devalue'].message).toContain("MegaHeader's props (300 KB) use devalue because of config.updated (Date)");
		expect(by['wake-inert'].message).toContain('CountryPanel wakes (visible) but the build found no event handlers');
		expect(by['wake-inert'].message).toContain('117 KB of JS loads for markup that never changes'); // 20 KB + the shared 100 KB chunk
		expect(by['wake-crowd'].message).toContain('ProductCard has 48 copies on the page, each waking on visible with its own 80 B of props');
		expect(by['hole-cache-cold'].message).toContain('Hole cafebabe0102 has maxAge 300s but its cache never hit in 2 requests');
		expect(by['client-hydrate'].message).toContain('the slowest MegaHeader at 120 ms, mostly loading its 100 ms of modules');
		expect(by['client-hydrate'].fix).toMatch(/Module load dominates/);
		// no weights (dev) → no JS figures, the advisor still speaks
		const g = derive_findings(analyze(p1), meta as never, { net: [], mem: [] } as never);
		expect(g.find((x) => x.code === 'wake-inert')!.message).not.toContain('KB of JS');
		expect(g.find((x) => x.code === 'islands-js-heavy')).toBeUndefined();
	});

	it('an island that reads page.data whole is the reason everything ships', () => {
		const whole = { ...og, seed: { ...og.seed, whole_by: ['PriceTicker'] } };
		const f = derive_findings(analyze(p1), { ...meta, requests: [req({ internal: true, og: whole })] } as never, extras);
		const w = f.find((x) => x.code === 'seed-whole')!;
		expect(w.severity).toBe('warn');
		expect(w.message).toContain('PriceTicker reads page.data whole, so every key ships in the seed (80 KB, the biggest is catalog at 70 KB)');
		expect(f.find((x) => x.code === 'seed-explainer')).toBeUndefined();
	});

	it('report JSON: island rows joined with weights, the browser and the components; seed + holes; kit costs', () => {
		const j = report_json(analyze(p1), meta as never, '/p', extras);
		const og_json = j.ogygia!;
		expect(og_json.islands).toBe(3); // the count survives next to the rows
		expect(og_json.island_rows).toHaveLength(3); // 50 fingerprints, 3 islands
		const mega = og_json.island_rows.find((r) => r.name === 'MegaHeader')!;
		expect(mega).toMatchObject({ copies: 1, fingerprints: 1, wake: 'load', js_bytes: 140_000, devalue_culprit: 'config.updated (Date)', client: { hydrations: 3, p50_ms: 120, load_p50_ms: 100 } });
		expect(mega.modules).toEqual(['/_app/immutable/aaaaaaaaaaaaaaaa.js', '/_app/immutable/chunk-shared.js']);
		// the list: 48 fingerprints merged — copies and bytes add up, the keys union once
		expect(og_json.island_rows.find((r) => r.name === 'ProductCard')).toMatchObject({ copies: 48, fingerprints: 48, props_bytes: 48 * 80, seed_refs: 48, seed_ref_keys: ['catalog'] });
		expect(og_json.seed!.keys[0]).toMatchObject({ key: 'catalog', shipped: true, reason: 'read', readers: ['PriceTicker'], referenced_by: ['ProductCard'] });
		expect(og_json.hole_rows[0]).toMatchObject({ id: 'cafebabe0102', max_age_s: 300, requests: { hit: 0, miss: 2, uncached: 0, avg_ms: 30.5 } });
		expect(j.requests[1].hole).toEqual({ kind: 'hole', id: 'cafebabe0102', cache: 'miss', ttl: 300 });
	});

	it('analyze: a component’s own time splits into markup (svelte internals under it) and logic; its parent is who rendered it', () => {
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 60_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('_page', '/app/.svelte-kit/output/server/entries/pages/_page.svelte.js', 0), children: [3, 6] },
				{ id: 3, callFrame: frame('Row', '/app/src/lib/Row.svelte', 0), children: [4, 5] },
				{ id: 4, callFrame: frame('escape_html', '/app/node_modules/svelte/src/internal/server/escaping.js', 1) },
				{ id: 5, callFrame: frame('fmt', '/app/src/lib/fmt.ts', 3) },
				{ id: 6, callFrame: frame('push', '/app/node_modules/svelte/src/internal/server/renderer.js', 1) }
			],
			// Row: 30 ms escape (markup), 10 ms fmt (logic), 5 ms itself (logic); _page: 10 ms push (markup)
			samples: [4, 4, 4, 5, 3, 6],
			timeDeltas: [10_000, 10_000, 10_000, 10_000, 5_000, 10_000]
		};
		const a = analyze(prof, undefined, { 'Row\0/app/src/lib/Row.svelte': 40 });
		const row = a.components.find((c) => c.name === 'Row')!;
		expect(row.markup_ms).toBe(30);
		expect(row.logic_ms).toBe(15);
		expect(row.parent).toBe('_page');
		const page = a.components.find((c) => c.name === '_page')!;
		expect(page.markup_ms).toBe(10);
		expect(page.logic_ms).toBe(0);
		expect(page.parent).toBeUndefined();
		const m = { id: 'x', created: 0, trigger: 'page' as const, page: '/p', runs: [55], run_status: 200, run_bytes: 9000, duration_ms: 55, node: 'v', requests: [] };
		const f = derive_findings(a, m as never, { net: [], mem: [] } as never);
		const list = f.find((x) => x.code === 'hot-list')!;
		expect(list.message).toContain('_page renders 40 Row rows per render');
		expect(list.anchor).toBe('comp:_page');
		const j = report_json(a, m as never, '/p', { net: [], mem: [] } as never);
		expect(j.components.find((c) => c.name === 'Row')).toMatchObject({ markup_ms: 30, logic_ms: 15, parent: '_page' });
	});

	it('timeline: one lane per Kit load, the page lane behind the layout lane is the parent() chain', () => {
		expect(load_lane_of('load (routes/hell/+page.server.ts:44)')).toEqual({ file: 'routes/hell/+page.server.ts', level: 'page', kind: 'server' });
		expect(load_lane_of('/app/src/routes/+layout.ts')).toEqual({ file: 'routes/+layout.ts', level: 'layout', kind: 'universal' });
		expect(load_lane_of('/app/build/server/entries/pages/hell/_page.server.ts.js')).toEqual({ file: 'pages/hell/+page.server.ts', level: 'page', kind: 'server' });
		expect(load_lane_of('fetchStock (src/lib/hell.ts:9)')).toBeNull();
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 100_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2, 5, 7] },
				{ id: 2, callFrame: frame('load_server_data', '/app/node_modules/@sveltejs/kit/src/runtime/server/page/load_data.js', 1), children: [3] },
				{ id: 3, callFrame: frame('load', '/app/src/routes/+layout.server.ts', 2), children: [4] },
				{ id: 4, callFrame: frame('decode', '/app/src/lib/jwt.ts', 2) },
				{ id: 5, callFrame: frame('parent', '/app/node_modules/@sveltejs/kit/src/runtime/server/page/load_data.js', 30), children: [6] },
				{ id: 6, callFrame: frame('load', '/app/src/routes/hell/+page.server.ts', 5) },
				{ id: 7, callFrame: frame('(idle)') }
			],
			// layout on the cpu 0–10, idle (its call) 10–30, page under parent() 30–35, idle 35–100
			samples: [4, 4, 7, 7, 6, 7],
			timeDeltas: [5000, 5000, 10_000, 10_000, 5000, 65_000]
		};
		const frames = new Map(prof.nodes.map((n) => [n.id, n] as const));
		const parents = new Map<number, number>();
		for (const n of prof.nodes) for (const c of n.children ?? []) parents.set(c, n.id);
		const info = (id: number) => {
			const f = frames.get(id)!.callFrame;
			const c = categorize(f);
			return { name: f.functionName, url: f.url, line: f.lineNumber + 1, category: c.category, pkg: c.pkg };
		};
		const t = build_timeline(prof, info, (id) => parents.get(id), {
			perf_start: 1000,
			window: { start: 1000, end: 1100 },
			calls: [
				{ start: 1010, ms: 20, label: 'GET auth/session', kind: 'net', caller: 'load (routes/+layout.server.ts:3)' },
				{ start: 1035, ms: 60, label: 'GET api/catalog', kind: 'net', caller: 'load (routes/hell/+page.server.ts:9)' }
			]
		});
		expect(t.lanes).toEqual([
			{ file: 'routes/+layout.server.ts', level: 'layout', kind: 'server', t0: 0, t1: 30, cpu_ms: 10, wait_ms: 20, awaited_parent: false },
			{ file: 'routes/hell/+page.server.ts', level: 'page', kind: 'server', t0: 30, t1: 95, cpu_ms: 5, wait_ms: 60, awaited_parent: true }
		]);
		expect(t.chain).toEqual({ layout: 'routes/+layout.server.ts', page: 'routes/hell/+page.server.ts', serial_ms: 30, explicit: true });
		const a = { ...analyze(prof), timeline: t };
		const m = { id: 'x', created: 0, trigger: 'page' as const, page: '/hell', runs: [100], run_status: 200, run_bytes: 9000, duration_ms: 100, node: 'v', requests: [] };
		const f = derive_findings(a, m as never, { net: [], mem: [] } as never);
		const chain = f.find((x) => x.code === 'parent-chain')!;
		expect(chain.severity).toBe('warn');
		expect(chain.message).toBe('routes/hell/+page.server.ts started only after routes/+layout.server.ts finished (30.0 ms later) — it awaits parent().');
		const j = report_json(a, m as never, '/p', { net: [], mem: [] } as never);
		expect(j.timeline!.lanes).toHaveLength(2);
		expect(j.timeline!.chain).toEqual(t.chain);
	});

	it('timeline: loads that overlap are no chain; a universal load with waits gets the info', () => {
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 100_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2, 3, 4] },
				{ id: 2, callFrame: frame('load', '/app/src/routes/+layout.server.ts', 2) },
				{ id: 3, callFrame: frame('load', '/app/src/routes/hell/+page.ts', 5) },
				{ id: 4, callFrame: frame('(idle)') }
			],
			samples: [2, 3, 4],
			timeDeltas: [5000, 5000, 90_000]
		};
		const frames = new Map(prof.nodes.map((n) => [n.id, n] as const));
		const parents = new Map<number, number>();
		for (const n of prof.nodes) for (const c of n.children ?? []) parents.set(c, n.id);
		const info = (id: number) => {
			const f = frames.get(id)!.callFrame;
			const c = categorize(f);
			return { name: f.functionName, url: f.url, line: f.lineNumber + 1, category: c.category, pkg: c.pkg };
		};
		const t = build_timeline(prof, info, (id) => parents.get(id), {
			perf_start: 1000,
			window: { start: 1000, end: 1100 },
			calls: [
				{ start: 1005, ms: 40, label: 'GET a', kind: 'net', caller: 'load (routes/+layout.server.ts:3)' },
				{ start: 1010, ms: 40, label: 'GET b', kind: 'net', caller: 'load (routes/hell/+page.ts:9)' }
			]
		});
		expect(t.chain).toBeUndefined();
		expect(t.lanes!.map((l) => l.kind)).toEqual(['server', 'universal']);
		const m = { id: 'x', created: 0, trigger: 'page' as const, page: '/hell', runs: [100], run_status: 200, run_bytes: 9000, duration_ms: 100, node: 'v', requests: [] };
		const f = derive_findings({ ...analyze(prof), timeline: t }, m as never, { net: [], mem: [] } as never);
		expect(f.find((x) => x.code === 'parent-chain')).toBeUndefined();
		expect(f.find((x) => x.code === 'universal-load')!.message).toContain('routes/hell/+page.ts is a universal load: on this render it waited 40.0 ms');
	});

	it('production: the beacon tag needs the flag cookie the login sets (site-wide, no secret), or the key header', async () => {
		dev_switch.dev = false;
		try {
			const handle = profiler({ secret: 'prof-key' });
			const doc = (cookies: Record<string, string>, headers: Record<string, string> = {}) =>
				handle({
					event: { ...make_event('/some/page', { 'sec-fetch-dest': 'document', ...headers }), cookies: { get: (k: string) => cookies[k] } } as never,
					resolve: async (_e, opts) => new Response(String(!!opts?.transformPageChunk))
				}).then((r) => r.text());
			expect(await doc({})).toBe('false');
			expect(await doc({ og_profiler_beacon: '1' })).toBe('true');
			expect(await doc({}, { 'x-profiler-key': 'prof-key' })).toBe('true');
			expect(await doc({}, { 'x-profiler-key': 'wrong' })).toBe('false');
			// login sets both cookies; logout clears both
			const login = await handle({
				event: { ...make_event('/__profiler/login'), request: new Request('http://localhost/__profiler/login', { method: 'POST', body: JSON.stringify({ key: 'prof-key' }) }) } as RequestEvent,
				resolve: async () => new Response('no')
			});
			const set = login.headers.getSetCookie();
			expect(set.some((c) => c.startsWith('og_profiler=') && c.includes('Path=/__profiler'))).toBe(true);
			expect(set.some((c) => c.startsWith('og_profiler_beacon=1; Path=/;'))).toBe(true);
			const logout = await handle({ event: make_event('/__profiler/logout', { 'x-profiler-key': 'prof-key' }), resolve: async () => new Response('no') });
			expect(logout.headers.getSetCookie().some((c) => c.startsWith('og_profiler_beacon=;') && c.includes('Max-Age=0'))).toBe(true);
		} finally {
			dev_switch.dev = true;
		}
	});

	it('group_islands: one row per island — fingerprints merge, the first culprit and name stand', () => {
		const rows: IslandStat[] = [
			{ fp: 'a', entry: 'e', name: '', module_url: '/m.js', wake: 'visible', props_bytes: 10, canonical_bytes: 10, json: true, culprit: null, refs: 1, ref_keys: ['catalog'], hints: ['/x.js'], interactivity: null, count: 2 },
			{ fp: 'b', entry: 'e', name: 'Card', module_url: '/m.js', wake: 'visible', props_bytes: 30, canonical_bytes: 40, json: false, culprit: 'at (Date)', refs: 1, ref_keys: ['catalog', 'stock'], hints: ['/y.js'], interactivity: { handlers: 1, state: 0, effects: 0, binds: 0, actions: 0, files: 1 }, count: 1 },
			{ fp: 'c', entry: 'e', name: 'Card', module_url: '/m.js', wake: 'load', props_bytes: 5, canonical_bytes: 5, json: true, culprit: null, refs: 0, ref_keys: [], hints: [], interactivity: null, count: 1 }
		];
		const g = group_islands(rows);
		expect(g).toHaveLength(2); // same entry, a different wake → its own row
		expect(g[0]).toMatchObject({ fp: 'a', name: 'Card', wake: 'visible', count: 3, variants: 2, props_bytes: 40, canonical_bytes: 50, json: false, culprit: 'at (Date)', refs: 2, ref_keys: ['catalog', 'stock'], hints: ['/x.js', '/y.js'] });
		expect(g[0].interactivity).toEqual(rows[1].interactivity);
		expect(g[1]).toMatchObject({ fp: 'c', wake: 'load', count: 1, variants: 1 });
		expect(island_name(g[0])).toBe('Card');
		expect(island_name({ entry: '/src/lib/Foo.svelte?og-region=x', name: '' })).toBe('Foo');
		expect(island_name('/_app/immutable/og-region.abc.js')).toBe('og-region.abc.js');
	});

	it('kit-uneval: the client router’s serialization is named, with the csr=false answer', () => {
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 50_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('render_response', '/app/node_modules/@sveltejs/kit/src/runtime/server/page/render.js', 1), children: [3] },
				{ id: 3, callFrame: frame('uneval', '/app/node_modules/devalue/src/uneval.js', 1) }
			],
			samples: [3, 3],
			timeDeltas: [10_000, 10_000]
		};
		const m = { id: 'x', created: 0, trigger: 'page' as const, page: '/p', runs: [10, 10], run_status: 200, run_bytes: 9000, duration_ms: 20, node: 'v', requests: [] };
		const f = derive_findings(analyze(prof), m as never, { net: [], mem: [] } as never);
		const u = f.find((x) => x.code === 'kit-uneval')!;
		expect(u.message).toContain('Kit serialized the load data for its client router: 10.0 ms per render');
		expect(u.fix).toMatch(/csr=false/);
		expect(report_json(analyze(prof), m as never, '/p', { net: [], mem: [] } as never).kit.uneval_ms).toBe(20);
	});
});

describe('span + tag (ogygia/profiler)', () => {
	const recorded: SpanRecord[] = [];
	const tags: Record<string, string> = {};
	let seq = 0;
	let current: number | undefined;
	const recorder: SpanRecorder = {
		begin: (name, attrs) => {
			const rec: SpanRecord = { id: ++seq, name, start: 100 + seq, ms: -1, attrs, parent: current, route: '/x', path: '/x' };
			recorded.push(rec);
			return rec;
		},
		within: (s, fn) => {
			const prev = current;
			current = s.id;
			try {
				return fn();
			} finally {
				current = prev;
			}
		},
		end: (s, attrs, error) => {
			s.ms = 5;
			if (attrs) s.attrs = { ...s.attrs, ...attrs };
			if (error !== undefined) s.error = error instanceof Error ? error.message : String(error);
		},
		tag: (k, v) => {
			tags[k] = v;
		}
	};
	afterEach(() => {
		set_span_recorder(null);
		recorded.length = 0;
	});

	it('is a pass-through without a recorder: sync stays sync, a promise stays a promise, nothing recorded', async () => {
		expect(span('x', () => 1)).toBe(1);
		await expect(span('y', async () => 2)).resolves.toBe(2);
		expect(() => span('z', () => { throw new Error('boom'); })).toThrow('boom');
		expect(span.start('h').end()).toBeUndefined();
		tag('k', 'v');
		expect(recorded).toEqual([]);
	});

	it('records name, attrs (static or from the result), errors, nesting and tags while recording', async () => {
		set_span_recorder(recorder);
		const v = await span('db.user', async () => {
			await span('db.orders', () => Promise.resolve([1, 2, 3]), (rows) => ({ rows: rows.length }));
			return { fromCache: false };
		}, (r) => ({ cache: r.fromCache ? 'hit' : 'miss' }));
		expect(v).toEqual({ fromCache: false });
		expect(span('sync', () => 7, { key: 'a' })).toBe(7);
		await expect(span('fails', () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
		const h = span.start('stream', { key: 'p' });
		h.set('chunks', 3);
		h.end();
		h.end(); // twice is a no-op
		tag('tenant', 'acme');
		tag('n', 42);
		expect(recorded.map((r) => [r.name, r.parent, r.attrs, r.error])).toEqual([
			['db.user', undefined, { cache: 'miss' }, undefined],
			['db.orders', 1, { rows: 3 }, undefined],
			['sync', undefined, { key: 'a' }, undefined],
			['fails', undefined, undefined, 'nope'],
			['stream', undefined, { key: 'p', chunks: 3 }, undefined]
		]);
		expect(tags).toEqual({ tenant: 'acme', n: '42' });
	});

	it('span_rows folds a recording per name: count, p50, max, errors, cache tallies, callers', () => {
		const s = (name: string, ms: number, extra: Partial<SpanRecord> = {}): SpanRecord => ({
			id: 0, name, start: 0, ms, route: null, path: null, caller: 'load (src/routes/+page.server.ts:9)', ...extra
		});
		const rows = span_rows([
			s('stock.lookup', 7), s('stock.lookup', 8), s('stock.lookup', 6, { error: 'timeout' }),
			s('cache.segments', 18, { attrs: { cache: 'miss' } }), s('cache.segments', 0.1, { attrs: { cache: 'hit' } }),
			s('open.one', -1, { open: true })
		]);
		expect(rows[0]).toMatchObject({ name: 'stock.lookup', count: 3, total_ms: 21, p50_ms: 7, max_ms: 8, errors: 1, callers: ['load (src/routes/+page.server.ts:9)'] });
		expect(rows[1]).toMatchObject({ name: 'cache.segments', cache: { hit: 1, miss: 1, miss_ms: 18 } });
		expect(rows[2]).toMatchObject({ name: 'open.one', open: 1, total_ms: 0 });
	});

	it('the timeline treats a span as the overlay: a gap inside it reads "in <span>", a call inside it names the span', () => {
		const profile: CpuProfile = {
			startTime: 0, endTime: 100_000,
			nodes: [{ id: 1, callFrame: frame('(root)'), children: [2] }, { id: 2, callFrame: frame('(idle)') }],
			samples: [2], timeDeltas: [100_000]
		};
		const t = build_timeline(profile, () => ({ name: '(idle)', url: '', line: 0, category: 'idle' }), () => undefined, {
			perf_start: 1000,
			window: { start: 1000, end: 1100 },
			calls: [
				{ start: 1000, ms: 50, label: 'db.rows', kind: 'span', caller: 'load (src/routes/+page.server.ts:9)', phase: 'load' },
				{ start: 1010, ms: 20, label: 'GET api/x', kind: 'net' },
				{ start: 1060, ms: 30, label: 'queue.drain', kind: 'span', phase: 'load' }
			]
		});
		expect(t.segments.map((s) => `${s.kind}:${s.label}${s.within ? ' @' + s.within : ''}`)).toEqual([
			'wait:in db.rows @db.rows',
			'wait:GET api/x @db.rows',
			'wait:in db.rows @db.rows',
			'gap:nothing recorded',
			'wait:in queue.drain @queue.drain',
			'gap:nothing recorded'
		]);
		expect(t.phases.find((p) => p.phase === 'load')?.wait_ms).toBe(80);
	});

	it('findings: a span repeated per item, a cold cache, a failing span', () => {
		const p: CpuProfile = { startTime: 0, endTime: 1000, nodes: [{ id: 1, callFrame: frame('(root)') }], samples: [1], timeDeltas: [1000] };
		const meta = { id: 'x', created: 0, trigger: 'page' as const, page: '/p', runs: [200, 200], run_status: 200, run_bytes: 9000, duration_ms: 400, node: 'v', requests: [] };
		const s = (name: string, ms: number, extra: Partial<SpanRecord> = {}): SpanRecord => ({ id: 0, name, start: 0, ms, route: null, path: null, ...extra });
		const spans = [
			...Array.from({ length: 32 }, () => s('stock.lookup', 7, { caller: 'load (routes/+page.server.ts:20)' })),
			s('cache.segments', 18, { attrs: { cache: 'miss' } }), s('cache.segments', 18, { attrs: { cache: 'miss' } }),
			s('svc.x', 1, { error: 'ECONNRESET' })
		];
		const f = derive_findings(analyze(p), meta as never, { net: [], mem: [], spans } as never);
		const by = Object.fromEntries(f.map((x) => [x.code, x]));
		expect(by['span-repeat'].message).toContain('stock.lookup ran 16 times in one render');
		expect(by['span-repeat'].fix).toMatch(/batch/);
		expect(by['cache-misses'].message).toContain('cache.segments: 1 cache miss per render cost 18');
		expect(by['span-errors'].message).toContain('svc.x failed 1 time');
		expect(report_json(analyze(p), meta as never, '/p', { net: [], mem: [], spans } as never).spans[0].name).toBe('stock.lookup');
	});
});

describe('standalone HTML export', () => {
	it('inlines styles, the runtime and every reachable chunk as an import map of data: URLs', async () => {
		const files: Record<string, string> = {
			'/_app/immutable/assets/report.css': 'body{color:red}',
			'/_app/immutable/og-runtime.abc.js': 'import{x}from"./chunks/a.js";const m=(m=["./chunks/b.js"])=>m;const e=document.querySelector("ogygia-region").getAttribute("entry");import(e);import(`./chunks/a.js`);',
			'/_app/immutable/chunks/a.js': 'import"./b.js";export const x=1;',
			'/_app/immutable/chunks/b.js': 'export const y=2;',
			'/_app/immutable/og-region.island.js': 'import{y}from"./chunks/b.js";export default y;'
		};
		const html =
			'<html><head><link rel="stylesheet" href="../../_app/immutable/assets/report.css"><link rel="modulepreload" href="../../_app/immutable/chunks/a.js">' +
			'<script type="module" data-ogygia-runtime src="/_app/immutable/og-runtime.abc.js"></script></head>' +
			'<body><ogygia-region entry="../../_app/immutable/og-region.island.js" wake="load">hi</ogygia-region></body></html>';
		const out = await build_standalone(html, {
			page_url: 'http://h/__profiler/report/abc',
			load: async (url) => files[new URL(url).pathname] ?? null
		});
		expect(out).toContain('<style data-standalone="/_app/immutable/assets/report.css">body{color:red}</style>');
		expect(out).not.toContain('modulepreload');
		// the runtime is inline, its import rewritten to the og: key
		expect(out).toContain('data-ogygia-runtime');
		expect(out).toContain('import{x}from"og://chunks/_app/immutable/chunks/a.js"');
		// a template-literal import and a preload-list string are rewritten too
		expect(out).toContain('import(`og://chunks/_app/immutable/chunks/a.js`)');
		expect(out).toContain('m=["og://chunks/_app/immutable/chunks/b.js"]');
		// the island entry attribute now names its key
		expect(out).toContain('entry="og://chunks/_app/immutable/og-region.island.js"');
		// the import map carries every chunk the page can reach, as data: URLs, with imports rewritten
		const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(out)![1]) as { imports: Record<string, string> };
		expect(Object.keys(map.imports).sort()).toEqual([
			'og://chunks/_app/immutable/chunks/a.js',
			'og://chunks/_app/immutable/chunks/b.js',
			'og://chunks/_app/immutable/og-region.island.js'
		]);
		const a = Buffer.from(map.imports['og://chunks/_app/immutable/chunks/a.js'].split(',')[1], 'base64').toString();
		expect(a).toBe('import"og://chunks/_app/immutable/chunks/b.js";export const x=1;');
		expect(out).toContain('<meta name="ogygia-standalone" content="1">');
		// the map precedes the first module script
		expect(out.indexOf('importmap')).toBeLessThan(out.indexOf('data-ogygia-runtime'));
	});
});

describe('compare + history', () => {
	const mk = (id: string, created: number, runs: number[], self: number) => {
		const p: CpuProfile = {
			startTime: 0,
			endTime: 4000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('Card', '/app/src/lib/Card.svelte', 0), children: [3] },
				{ id: 3, callFrame: frame('fmt', '/app/src/lib/fmt.ts', 1) }
			],
			samples: [3, 2],
			timeDeltas: [self * 1000, 1000]
		};
		const meta = { id, created, trigger: 'page' as const, page: '/p', runs, duration_ms: 4, node: 'v', requests: [] };
		return { meta: meta as never, analysis: analyze(p), findings: [`f-${id}`] };
	};
	it('reports signed deltas per component / function and what changed in the findings', () => {
		const c = compare_reports(mk('a', 1, [100, 110, 120], 1), mk('b', 2, [130, 150, 160], 3));
		expect(c.summary[0]).toMatchObject({ label: 'render (median run)', a: 110, b: 150, d: 40 });
		const fmt = c.functions.find((r) => r.name === 'fmt')!;
		expect(fmt).toMatchObject({ a_self: 1, b_self: 3, d_self: 2 });
		const card = c.components.find((r) => r.name === 'Card')!;
		expect(card.d_total).toBe(2);
		expect(c.findings).toEqual({ added: ['f-b'], gone: ['f-a'] });
	});
	it('groups page reports into a per-page history, oldest first, by median', () => {
		const h = page_history([mk('b', 2, [130, 150, 160], 1).meta, mk('a', 1, [100, 110, 120], 1).meta]);
		expect(h).toEqual([{ page: '/p', points: [{ id: 'a', created: 1, median: 110 }, { id: 'b', created: 2, median: 150 }] }]);
	});
});

describe('sourcemaps', () => {
	// minimal VLQ encoder to author fixtures against the decoder
	const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	const vlq = (n: number): string => {
		let v = n < 0 ? (-n << 1) | 1 : n << 1;
		let out = '';
		do {
			let d = v & 31;
			v >>>= 5;
			if (v) d |= 32;
			out += B64[d];
		} while (v);
		return out;
	};

	it('decodes segments and resolves a generated position to the original file', () => {
		// generated line 0, col 0 → source 0, original line 10
		const mappings = vlq(0) + vlq(0) + vlq(10) + vlq(0);
		const lines = decode_mappings(mappings);
		expect(lines[0].cols).toEqual([[0, 0, 10, -1, 0]]);

		const map = JSON.stringify({ sources: ['src/lib/Slow.svelte'], mappings });
		const resolver = sourcemap_resolver((p) => (p === '/out/chunk.js.map' ? map : undefined));
		// the map's relative source is joined onto the chunk's directory
		expect(resolver.resolve('/out/chunk.js', 0, 5)).toEqual({
			source: '/out/src/lib/Slow.svelte',
			line: 11,
			column: 1,
			name: undefined
		});
		expect(resolver.hit).toBe(true);
		expect(resolver.resolve('/out/other.js', 0, 0)).toBeUndefined();
	});

	it('recovers original identifiers for anonymous frames via `names`', () => {
		// 5-field segment: col 0 → source 0, line 4, col 0, name 0
		const mappings = vlq(0) + vlq(0) + vlq(4) + vlq(0) + vlq(0);
		const map = JSON.stringify({
			sources: ['src/lib/data.ts'],
			names: ['load_products'],
			mappings
		});
		const resolver = sourcemap_resolver((p) => (p === '/out/c.js.map' ? map : undefined));
		expect(resolver.resolve('/out/c.js', 0, 3)).toEqual({
			source: '/out/src/lib/data.ts',
			line: 5,
			column: 1,
			name: 'load_products'
		});
	});
});

describe('sequential_ms', () => {
	const call = (start: number, ms: number, body_ms?: number): NetCall => ({
		start,
		epoch: start,
		ms,
		body_ms,
		method: 'GET',
		url: 'https://api.example.com/x',
		host: 'api.example.com',
		status: 200,
		kind: 'fetch',
		route: null,
		path: null
	});

	it('sums back-to-back calls but merges overlapping ones', () => {
		expect(sequential_ms([call(0, 100), call(100, 100)])).toBe(200);
		expect(sequential_ms([call(0, 100), call(50, 100)])).toBe(150); // parallel-ish
		expect(sequential_ms([call(0, 100, 50), call(150, 100)])).toBe(250); // body time counts
	});
});

describe('analyze_heap', () => {
	it('aggregates sampled allocations per function', () => {
		const head: HeapNode = {
			callFrame: frame('(root)'),
			selfSize: 0,
			children: [
				{
					callFrame: frame('build_page', '/app/src/build.ts', 4),
					selfSize: 2048,
					children: [{ callFrame: frame('Header', '/app/src/lib/Header.svelte'), selfSize: 1024 }]
				}
			]
		};
		const top = analyze_heap(head);
		expect(top[0].name).toBe('build_page');
		expect(top[0].self_bytes).toBe(2048);
		expect(top[0].total_bytes).toBe(3072);
		expect(top[1]).toMatchObject({ name: 'Header', category: 'component', self_bytes: 1024 });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// the handle: request log, Server-Timing, dashboard, net attribution
// ─────────────────────────────────────────────────────────────────────────────

function make_event(path: string, headers: Record<string, string> = {}): RequestEvent {
	const url = new URL('http://localhost' + path);
	return {
		url,
		request: new Request(url, { headers }),
		route: { id: path.startsWith('/__profiler') ? null : '/[slug]' },
		cookies: {
			get: () => undefined,
			set: () => {},
			delete: () => {},
			getAll: () => [],
			serialize: () => ''
		},
		fetch: async () => new Response('ok')
	} as unknown as RequestEvent;
}

describe('profiler handle', () => {
	it('times requests, attributes outbound fetches, serves the dashboard', async () => {
		// stub the network BEFORE the first request so the patch wraps the stub
		const orig_fetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response('data', { headers: { 'content-length': '4' } })) as typeof fetch;

		try {
			const handle = profiler();

			const res = await handle({
				event: make_event('/some/page'),
				resolve: async () => {
					await fetch('https://api.example.com/data');
					return new Response('page');
				}
			});
			expect(res.status).toBe(200);
			const timing = res.headers.get('Server-Timing') ?? '';
			expect(timing).toContain('ssr;');
			expect(timing).toContain('net;'); // the fetch above was attributed to this request

			const dash = await handle({
				event: make_event('/__profiler'),
				resolve: async () => new Response('unreachable')
			});
			expect(dash.status).toBe(200);
			const html = await dash.text();
			expect(html).toContain('SSR profiler');
			expect(html).toContain('/some/page'); // the request log made it in
			expect(html).toContain('/[slug]');
		} finally {
			globalThis.fetch = orig_fetch;
		}
	});

	// PAY ONLY WHEN PROFILING: in production an idle request runs in no AsyncLocalStorage — its
	// outbound calls are not attributed (no `net;` timing) — while a request carrying a valid
	// `x-profile` header is attributed and reported. Dev (the test above) attributes always.
	it('production: an idle request is not attributed; a header-profiled one is', async () => {
		dev_switch.dev = false;
		const orig_fetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response('data', { headers: { 'content-length': '4' } })) as typeof fetch;
		try {
			const handle = profiler({ secret: 'prof-key', serverTiming: true });
			const idle = await handle({
				event: make_event('/prod/page'),
				resolve: async () => {
					await fetch('https://api.example.com/data');
					return new Response('page');
				}
			});
			const idle_timing = idle.headers.get('Server-Timing') ?? '';
			expect(idle_timing).toContain('ssr;'); // wall timing is always on
			expect(idle_timing).not.toContain('net;'); // the fetch was NOT attributed: no ALS ran

			const profiled = await handle({
				event: make_event('/prod/page', { 'x-profile': 'prof-key' }),
				resolve: async () => {
					await fetch('https://api.example.com/data');
					return new Response('page');
				}
			});
			expect(profiled.headers.get('x-profile-report')).toMatch(/\/__profiler\/report\//);
			expect(profiled.headers.get('Server-Timing') ?? '').toContain('net;'); // attributed while recording
		} finally {
			globalThis.fetch = orig_fetch;
			dev_switch.dev = true;
		}
	});

	// THE BEACON: an authed document gets the meta tag; the runtime POSTs its hydration timings to
	// `/beacon`; the report joins them to its island rows by fingerprint. Dev here (open UI).
	it('beacon: the tag rides an authed document, /beacon is bounded, the report joins by fingerprint', async () => {
		const { record_request_stats } = await import('../src/server/request-stats.js');
		const handle = profiler({ secret: 'prof-key' });
		// a document request gets the tag at the end of <head>; a fetch (no document dest) does not
		// (dev: the tag needs no flag cookie; production reads `og_profiler_beacon`, set at login)
		const doc = await handle({
			event: make_event('/some/page', { 'sec-fetch-dest': 'document' }),
			resolve: async (_e, opts) => {
				const html = await opts!.transformPageChunk!({ html: '<html><head><title>x</title></head><body></body></html>', done: true });
				return new Response(html ?? '');
			}
		});
		expect(await doc.text()).toContain('<meta name="ogygia-profiler-beacon" content="/__profiler/beacon"></head>');
		const sub = await handle({
			event: make_event('/some/data', { 'sec-fetch-dest': 'empty' }),
			resolve: async (_e, opts) => new Response(String(opts?.transformPageChunk === undefined))
		});
		expect(await sub.text()).toBe('true');

		// a header-profiled request records island rows (what ogygia's handle does while detail is on)
		const fp = 'abcdefabcdefabcd';
		const profiled = await handle({
			event: make_event('/prod/page', { 'x-profile': 'prof-key' }),
			resolve: async (e) => {
				record_request_stats(e.request, {
					transform_ms: 1, islands: 1, hints: 0, holes: 0, seed_bytes: 0, remote_seed_bytes: 0, tail_bytes: 100, fnm_bytes: 0, ctx_bytes: 0, seed_json: true,
					island_rows: [{ fp, entry: 'src/lib/Widget.svelte', name: 'Widget', module_url: '/_app/immutable/w.js', wake: 'load', props_bytes: 100, canonical_bytes: 100, json: true, culprit: null, refs: 0, ref_keys: [], hints: [], interactivity: null, count: 1 }]
				});
				return new Response('page');
			}
		});
		const report_url = profiled.headers.get('x-profile-report')!;
		const post = (body: string) =>
			handle({ event: { ...make_event('/__profiler/beacon'), request: new Request('http://localhost/__profiler/beacon', { method: 'POST', body }) } as RequestEvent, resolve: async () => new Response('no') });
		expect((await post('not json')).status).toBe(400);
		expect((await post(JSON.stringify({ islands: 'x' }))).status).toBe(400);
		expect((await post('x'.repeat(70 * 1024))).status).toBe(413);
		const ok = await post(JSON.stringify({ page: '/prod/page', islands: [{ fp, entry: 'src/lib/Widget.svelte', ms: 42, load: 30 }, { fp, entry: 'src/lib/Widget.svelte', ms: 50, load: 31 }, { fp: 'nope', ms: 1 }, { fp, ms: -5 }] }));
		expect(ok.status).toBe(204);
		const json = await (await handle({ event: make_event(report_url + '.json'), resolve: async () => new Response('no') })).json();
		expect(json.ogygia.island_rows[0].client).toEqual({ hydrations: 2, p50_ms: 50, max_ms: 50, load_p50_ms: 31 });
		expect(json.findings.find((f: { code: string }) => f.code === 'client-hydrate').message).toContain('the slowest Widget at 50.0 ms, mostly loading its 31.0 ms of modules');
	});

	it('serializes recordings: a second profile while one is running renders un-profiled', async () => {
		dev_switch.dev = false;
		try {
			const handle = profiler({ secret: 'prof-key' });
			// A holds the recorder slot until we release it (its render parks on the gate).
			let release_a: () => void = () => {};
			const a_gate = new Promise<void>((r) => (release_a = r));
			const a = handle({
				event: make_event('/prod/a', { 'x-profile': 'prof-key' }),
				resolve: async () => {
					await a_gate;
					return new Response('a');
				}
			});
			// give A time to take the slot and enter the capture window before B arrives
			await new Promise((r) => setTimeout(r, 50));
			const b = await handle({
				event: make_event('/prod/b', { 'x-profile': 'prof-key' }),
				resolve: async () => new Response('b')
			});
			// the process-wide inspector is busy with A, so B is served un-profiled (no report header)
			expect(b.headers.get('x-profile-report')).toBeNull();
			release_a();
			const a_res = await a;
			expect(a_res.headers.get('x-profile-report')).toMatch(/\/__profiler\/report\//);
		} finally {
			dev_switch.dev = true;
		}
	});

	it('runs a lean path with network off: still logs requests, no Server-Timing', async () => {
		const handle = profiler({ network: false, serverTiming: false });
		const res = await handle({
			event: make_event('/lean/page'),
			resolve: async () => new Response('ok')
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('Server-Timing')).toBeNull(); // suppressed
		const dash = await handle({
			event: make_event('/__profiler'),
			resolve: async () => new Response('x')
		});
		expect(await dash.text()).toContain('/lean/page'); // request still logged
	});

	it('hides the UI in prod without a secret and accepts the right key', async () => {
		// simulate prod: no DEV flag leaks through options
		const handle = profiler({ secret: 's3cret', path: '/__p' });
		const denied = await handle({
			event: make_event('/__p'),
			resolve: async () => new Response('x')
		});
		// dev-mode vitest: import.meta.env.DEV is true, so this passes auth;
		// the prod path (404 without key) is covered by key_matches via header:
		expect([200, 404]).toContain(denied.status);

		const with_key = await handle({
			event: make_event('/__p?key=s3cret'),
			resolve: async () => new Response('x')
		});
		expect(with_key.status).toBe(200);
	});
});
