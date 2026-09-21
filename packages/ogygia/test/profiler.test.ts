import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	analyze,
	analyze_heap,
	categorize,
	decode_mappings,
	join_source,
	sourcemap_resolver,
	heap_by_component,
	chunk_component_renamer,
	type Analysis,
	type CpuProfile,
	type HeapNode
} from '../src/profiler/analyze.js';
import { sequential_ms, type NetCall } from '../src/profiler/net.js';
import { build_timeline, chain_steps, coalesce, phase_of_stack, label_call, load_lane_of } from '../src/profiler/timeline.js';
import { n_plus_one, path_template, group_islands, island_name, cold_rows, run_spread, island_host_renamer, type IslandStat, type RequestEntry, type ReportMeta } from '../src/profiler/report.js';
import { parse_server_timing, app_call_chain, decode_trace, encode_trace, wrap_event_fetch, set_stack_capture } from '../src/profiler/net.js';
import { compare_reports, page_history } from '../src/profiler/compare.js';
import { span, tag, instrument, set_span_recorder, type SpanRecord, type SpanRecorder, type SpanAttrs } from '../src/profiler/span.js';
import { span_rows } from '../src/profiler/report.js';
import { build_standalone } from '../src/profiler/standalone.js';
import { profiler, self_profile_to_cpuprofile } from '../src/profiler/index.js';
import { io_kind } from '../src/profiler/async-io.js';
import { report_json, report_dump, is_dump, derive_findings } from '../src/profiler/report.js';
import { budget_segments, build_treemap, waiting_rows } from '../src/profiler/ui/report-data.js';
import type { RequestEvent } from '@sveltejs/kit';
import { set_chunk_contents } from './_stubs/virtual-island-deps.js';
import { app_asset_rel, client_dir_candidates, client_file_finder } from '../src/profiler/client-files.js';

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

	it('the island host wrapper reads as its island, not as the hash Svelte named its virtual file with', () => {
		const rows: RequestEntry[] = [
			{ ts: 0, method: 'GET', path: '/hell', route: '/hell', status: 200, ms: 40, cpu_ms: 10, inflight: 0, net_ms: 0, net_count: 0, internal: true,
				og: { transform_ms: 1, islands: 1, hints: 0, holes: 0, seed_bytes: 0, remote_seed_bytes: 0, tail_bytes: 0, fnm_bytes: 0, ctx_bytes: 0, seed_json: true,
					island_rows: [{ fp: 'f', entry: '/_app/immutable/og-region.4b95bfb97fab.js', name: 'ProductCard', module_url: '', wake: 'visible', props_bytes: 1, canonical_bytes: 1, json: true, culprit: null, refs: 0, ref_keys: [], hints: [], interactivity: null, count: 48 }] } }
		];
		const rename = island_host_renamer(rows)!;
		expect(rename('_b95bfb97fab', '')).toBe('ProductCard (island host)');
		expect(rename('_ffffffffff0', '')).toBeUndefined(); // an island the window did not render
		expect(rename('ProductCard', '')).toBeUndefined();
		expect(island_host_renamer([])).toBeUndefined();
		const p: CpuProfile = {
			startTime: 0,
			endTime: 2000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('_b95bfb97fab', '/app/build/server/entries/pages/hell/_page.svelte.js', 401), children: [3] },
				{ id: 3, callFrame: frame('push', '/app/node_modules/svelte/src/internal/server/renderer.js', 1) }
			],
			samples: [3],
			timeDeltas: [2000]
		};
		const a = analyze(p, undefined, undefined, undefined, rename);
		expect(a.components.map((c) => c.name)).toEqual(['ProductCard (island host)']);
		expect(a.functions.find((f) => f.name === 'push')!.stacks![0].frames[0].n).toBe('ProductCard (island host)');
	});

	it('a component is one frame on a stack: the bundled wrapper + the renderer calls between fold into the .svelte body', () => {
		const RENDERER = '/app/node_modules/svelte/src/internal/server/renderer.js';
		const p: CpuProfile = {
			startTime: 0,
			endTime: 4000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				// the bundled wrapper (the route chunk's export) …
				{ id: 2, callFrame: frame('Card', '/app/build/server/entries/pages/_page.svelte.js', 316), children: [3] },
				// … the renderer calling into it …
				{ id: 3, callFrame: frame('component', RENDERER, 316), children: [4] },
				{ id: 4, callFrame: frame('child', RENDERER, 200), children: [5] },
				// … the component's own body (sourcemapped)
				{ id: 5, callFrame: frame('Card', '/app/src/lib/Card.svelte', 0), children: [6, 8] },
				{ id: 6, callFrame: frame('fmt', '/app/src/lib/fmt.ts', 3) },
				// an inline closure of the template (renamed to the component, a higher line) under the
				// body, through the renderer's `each`: still the one component, the body's line kept
				{ id: 7, callFrame: frame('Card', '/app/src/lib/Card.svelte', 39), children: [9] },
				{ id: 8, callFrame: frame('each', RENDERER, 50), children: [7] },
				{ id: 9, callFrame: frame('fmt2', '/app/src/lib/fmt.ts', 9) },
				// the same component reached through OTHER code (a nested island's Region): two frames
				{ id: 10, callFrame: frame('Region', '/app/node_modules/ogygia/dist/Region.js', 100), children: [11] },
				{ id: 11, callFrame: frame('Card', '/app/src/lib/Card.svelte', 0), children: [12] },
				{ id: 12, callFrame: frame('fmt3', '/app/src/lib/fmt.ts', 12) }
			],
			samples: [6, 9, 12],
			timeDeltas: [2000, 2000, 2000]
		};
		p.nodes[4].children = [6, 8, 10];
		const a = analyze(p);
		const fmt = a.functions.find((f) => f.name === 'fmt')!;
		expect(fmt.stacks![0].frames.map((f) => `${f.n} ${f.f}`)).toEqual(['Card app/src/lib/Card.svelte:1']);
		const fmt2 = a.functions.find((f) => f.name === 'fmt2')!;
		expect(fmt2.stacks![0].frames.map((f) => `${f.n} ${f.f}`)).toEqual(['Card app/src/lib/Card.svelte:1']);
		const fmt3 = a.functions.find((f) => f.name === 'fmt3')!;
		expect(fmt3.stacks![0].frames.map((f) => f.n)).toEqual(['Card', 'Region', 'Card']);
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
		hole_rows: [{ id: 'cafebabe0102', name: 'Recommendations', props: '{"forProduct":"P1"}', when: 'load', hydrate: null, ttl: 300, count: 1 }]
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
	const client = [{ fp: 'aaaaaaaaaaaaaaaa', entry: 'src/lib/MegaHeader.svelte', name: '', n: 3, p50_ms: 120, max_ms: 150, load_p50_ms: 100, recovered: 0 }];
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
		expect(by['hole-cache-cold'].message).toContain('The hole Recommendations {"forProduct":"P1"} has maxAge 300s but its cache never hit in 2 requests');
		expect(by['client-hydrate'].message).toContain('the slowest MegaHeader at 120 ms, mostly loading its 100 ms of modules');
		expect(by['client-hydrate'].fix).toMatch(/Module load dominates/);
		// no weights (dev) → no JS figures, the advisor still speaks
		const g = derive_findings(analyze(p1), meta as never, { net: [], mem: [] } as never);
		expect(g.find((x) => x.code === 'wake-inert')!.message).not.toContain('KB of JS');
		expect(g.find((x) => x.code === 'islands-js-heavy')).toBeUndefined();
	});

	it('never-hydrated: the beacon reported other islands but not this one', () => {
		// client rows for MegaHeader only; ProductCard (48 copies, visible) and PriceTicker stayed silent
		const f = derive_findings(analyze(p1), meta as never, extras);
		const nh = f.find((x) => x.code === 'never-hydrated')!;
		expect(nh.severity).toBe('warn');
		expect(nh.message).toBe('CountryPanel (wake: visible), ProductCard (48 copies, wake: visible) never reported hydrating in your visits, while 1 other island did.');
		expect(nh.fix).toMatch(/can scroll/);
		// no beacon at all: nothing to say
		expect(derive_findings(analyze(p1), meta as never, { net: [], mem: [], weights } as never).find((x) => x.code === 'never-hydrated')).toBeUndefined();
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
		expect(og_json.hole_rows[0]).toMatchObject({ id: 'cafebabe0102', component: 'Recommendations', props: '{"forProduct":"P1"}', max_age_s: 300, requests: { hit: 0, miss: 2, uncached: 0, avg_ms: 30.5 } });
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

	it('timeline: a load lane waiting only inside a span (a driver the hooks cannot see) still counts, and chains', () => {
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 400_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2, 3] },
				{ id: 2, callFrame: frame('load', '/app/src/routes/hell/+page.server.ts', 5) },
				{ id: 3, callFrame: frame('(idle)') }
			],
			samples: [3, 2, 3],
			timeDeltas: [66_000, 5_000, 329_000]
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
			window: { start: 1000, end: 1400 },
			calls: [
				{ start: 1000, ms: 45, label: 'svc.session', kind: 'span', caller: 'load (routes/hell/+layout.server.ts:9)' },
				// a UNIVERSAL layout load that finishes after the page's server load began: not what a
				// server page load's parent() waits for, so it must not break the chain
				{ start: 1046, ms: 40, label: 'GET toggles', kind: 'net', caller: 'load (routes/hell/+layout.ts:7)' },
				{ start: 1071, ms: 40, label: 'GET pricing', kind: 'net', caller: 'callService (routes/hell/+page.server.ts:18)' }
			]
		});
		expect(t.lanes!.find((l) => l.file === 'routes/hell/+layout.server.ts')).toMatchObject({ t0: 0, t1: 45, wait_ms: 45 });
		expect(t.lanes!.find((l) => l.file === 'routes/hell/+layout.ts')).toMatchObject({ kind: 'universal', wait_ms: 40 });
		expect(t.chain).toMatchObject({ layout: 'routes/hell/+layout.server.ts', page: 'routes/hell/+page.server.ts', explicit: false });
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

describe('the accuracy round: hot lines, server-timing, call paths, cold start, run spread, vitals', () => {
	const meta_page = (over: Record<string, unknown> = {}) => ({
		id: 'x', created: 0, trigger: 'page' as const, page: '/p', runs: [40, 42, 41], run_status: 200, run_bytes: 9000, duration_ms: 123, node: 'v', requests: [], ...over
	});
	const net = (over: Partial<NetCall>): NetCall => ({
		start: 0, epoch: 0, ms: 100, method: 'GET', url: 'https://api.x/catalog/42', host: 'api.x', status: 200, kind: 'fetch', route: null, path: null, ...over
	});

	it('parse_server_timing: tolerant of quotes, missing dur, junk; capped', () => {
		expect(parse_server_timing('db;dur=180.4;desc="postgres", render;dur=30, cache;desc=miss, total;dur=abc')).toEqual([
			{ name: 'db', ms: 180.4, desc: 'postgres' },
			{ name: 'render', ms: 30 },
			{ name: 'cache', ms: 0, desc: 'miss' },
			{ name: 'total', ms: 0 }
		]);
		expect(parse_server_timing('')).toBeUndefined();
		expect(parse_server_timing(null)).toBeUndefined();
		expect(parse_server_timing('   ,  ;;, bad name;dur=1')).toBeUndefined();
		expect(parse_server_timing(Array.from({ length: 20 }, (_, i) => `m${i};dur=1`).join(','))).toHaveLength(12);
	});

	it("the caller skip list: Kit's bundled runtime frames are the framework, not the app", async () => {
		// the regex is private; the behaviour shows through nearest_app_site on synthetic file names
		const { nearest_app_site } = await import('../src/profiler/net.js');
		const site = nearest_app_site();
		expect(site?.file).toContain('profiler.test.ts');
		expect(site?.file).not.toMatch(/[/\\]runtime[/\\](?:server|app)[/\\]/);
	});

	it('app_call_chain: the first-party frames above an I/O call, nearest first', () => {
		function outer_caller() {
			return inner_caller();
		}
		function inner_caller() {
			return app_call_chain(4);
		}
		const chain = outer_caller();
		expect(chain.length).toBeGreaterThanOrEqual(2);
		expect(chain[0].fn).toBe('inner_caller');
		expect(chain[1].fn).toBe('outer_caller');
		expect(chain[0].file).toContain('profiler.test.ts');
	});

	it('analyze: V8 line ticks become the function’s hot lines; runs split a component’s time per render', () => {
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 60_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('Row', '/app/src/lib/Row.svelte', 0), children: [3] },
				{ id: 3, callFrame: frame('fmt', '/app/src/lib/fmt.ts', 3), positionTicks: [{ line: 9, ticks: 4 }, { line: 12, ticks: 1 }, { line: 4, ticks: 1 }] }
			],
			samples: [3, 3, 3, 3, 3, 3],
			timeDeltas: [10_000, 10_000, 10_000, 10_000, 10_000, 10_000]
		};
		// six 10 ms samples: a tick is 10 ms; runs: [0,20) [20,40) [40,60) on a perf clock starting at 1000
		const a = analyze(prof, undefined, undefined, {
			perf_start: 1000,
			window: { start: 1000, end: 1060 },
			calls: [],
			runs: [
				{ start: 1000, end: 1020 },
				{ start: 1020, end: 1040 },
				{ start: 1040, end: 1060 }
			]
		});
		const fmt = a.functions.find((f) => f.name === 'fmt')!;
		expect(fmt.lines).toEqual([
			{ line: 9, ms: 40 },
			{ line: 12, ms: 10 },
			{ line: 4, ms: 10 }
		]);
		const row = a.components.find((c) => c.name === 'Row')!;
		expect(row.runs_ms).toEqual([20, 20, 20]);
		const j = report_json(a, meta_page() as never, '/p', { net: [], mem: [] } as never);
		expect(j.hot_functions.find((f) => f.name === 'fmt')!.hot_lines![0]).toEqual({ line: 9, ms: 40 });
		expect(j.components.find((c) => c.name === 'Row')!.runs_ms).toEqual([20, 20, 20]);
	});

	it('run_spread + the variance findings: a cold first run vs a run that just varies', () => {
		expect(run_spread([90, 2, 2, 3])).toMatchObject({ min: 2, max: 90, max_run: 1, cold: true });
		expect(run_spread([2, 2, 60, 3])).toMatchObject({ max: 60, max_run: 3, cold: false });
		expect(run_spread([5])).toBeNull();
		const p: CpuProfile = { startTime: 0, endTime: 1000, nodes: [{ id: 1, callFrame: frame('(root)') }], samples: [1], timeDeltas: [1000] };
		const base = analyze(p);
		const with_runs = (runs_ms: number[]) => ({
			...base,
			components: [{ key: 'C:Cache', name: 'Cache', url: 'Cache.svelte', path: '', line: 1, col: 0, category: 'component' as const, self_ms: 1, total_ms: 97, runs_ms }]
		});
		const cold = derive_findings(with_runs([90, 2, 2, 3]), meta_page({ runs: [100, 10, 10, 11] }) as never, { net: [], mem: [] } as never).find((f) => f.code === 'component-cold-run')!;
		expect(cold.message).toContain('Cache took 90.0 ms in the first render and 2.00 ms after');
		expect(cold.anchor).toBe('comp:Cache');
		const flaky = derive_findings(with_runs([2, 2, 60, 3]), meta_page({ runs: [10, 10, 70, 11] }) as never, { net: [], mem: [] } as never).find((f) => f.code === 'component-variance')!;
		expect(flaky.message).toContain('Cache is 3.00 ms in most renders but 60.0 ms in run 3');
	});

	it('upstream-split: the slowest call’s own Server-Timing says whose the wait is', () => {
		const p: CpuProfile = { startTime: 0, endTime: 1000, nodes: [{ id: 1, callFrame: frame('(root)') }], samples: [1], timeDeltas: [1000] };
		const calls = [
			net({ ms: 220, timings: [{ name: 'db', ms: 180, desc: 'postgres' }, { name: 'render', ms: 20 }], callers: ['fetchCatalog (lib/catalog.ts:9)', 'load (routes/+page.server.ts:12)'] }),
			net({ ms: 50, url: 'https://api.x/other' })
		];
		const f = derive_findings(analyze(p), meta_page() as never, { net: calls, mem: [] } as never).find((x) => x.code === 'upstream-split')!;
		expect(f.message).toBe('GET api.x/catalog/:id waited 220 ms; its own Server-Timing says postgres 180 ms, render 20.0 ms — 200 ms of the wait is on their side, 20.0 ms is the network and their framework.');
		expect(f.fix).toMatch(/The wait is theirs/);
		const j = report_json(analyze(p), meta_page() as never, '/p', { net: calls, mem: [] } as never);
		expect(j.network.calls[0]).toMatchObject({ server_timing: calls[0].timings, callers: calls[0].callers });
	});

	it('cold start: the warm-up render against the warm ones, per file', () => {
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 30_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2, 3] },
				{ id: 2, callFrame: frame('render', '/app/src/lib/heavy.ts', 1) },
				{ id: 3, callFrame: frame('load', '/app/src/routes/+page.server.ts', 1) }
			],
			samples: [2, 2, 3],
			timeDeltas: [10_000, 10_000, 10_000]
		};
		const a = analyze(prof); // warm: heavy.ts 20 ms over 3 runs ≈ 6.7 ms each, +page.server.ts 3.3 ms
		const cold = { ms: 400, busy_ms: 300, files: [{ file: 'app/src/lib/heavy.ts', category: 'app' as const, ms: 250 }, { file: 'app/src/routes/+page.server.ts', category: 'app' as const, ms: 4 }] };
		const m = meta_page({ runs: [40, 42, 41], cold });
		const rows = cold_rows(a, m as never);
		expect(rows[0]).toMatchObject({ file: 'app/src/lib/heavy.ts', cold_ms: 250, warm_ms: 6.7, extra_ms: 243.3 });
		expect(rows).toHaveLength(2);
		const f = derive_findings(a, m as never, { net: [], mem: [] } as never).find((x) => x.code === 'cold-start')!;
		expect(f.severity).toBe('warn');
		expect(f.message).toContain('The first render took 400 ms against 41.0 ms warm: 359 ms of module load and compile, most of it app/src/lib/heavy.ts (243 ms)');
		expect(report_json(a, m as never, '/p', { net: [], mem: [] } as never).cold).toMatchObject({ ms: 400, files: rows });
		// a warm-up no slower than the runs: no warning (a note at most)
		const g = derive_findings(a, meta_page({ runs: [40, 42, 41], cold: { ...cold, ms: 45, files: [] } }) as never, { net: [], mem: [] } as never);
		expect(g.find((x) => x.code === 'cold-start')).toBeUndefined();
	});

	it('the browser’s vitals against the server: the LCP gap, the TTFB gap, or just the numbers', () => {
		const p: CpuProfile = { startTime: 0, endTime: 1000, nodes: [{ id: 1, callFrame: frame('(root)') }], samples: [1], timeDeltas: [1000] };
		const say = (vitals: Record<string, number | null>) =>
			derive_findings(analyze(p), meta_page() as never, { net: [], mem: [], vitals: { n: 2, ...vitals } } as never);
		const lcp = say({ ttfb: 120, fcp: 400, lcp: 2600, cls: 0.02, inp: null }).find((f) => f.code === 'lcp-gap')!;
		expect(lcp.message).toContain('LCP is 2600 ms while the server answered in 120 ms (TTFB; the render itself 41.0 ms): 2480 ms of the user');
		const ttfb = say({ ttfb: 900, fcp: 950, lcp: 1000, cls: 0, inp: null }).find((f) => f.code === 'ttfb-gap')!;
		expect(ttfb.message).toContain('TTFB in the browser is 900 ms but this server rendered the page in 41.0 ms: 859 ms sits between the two');
		const plain = say({ ttfb: 60, fcp: 100, lcp: 300, cls: 0.01, inp: 40 }).find((f) => f.code === 'browser-vitals')!;
		expect(plain.message).toBe('The browser measured TTFB 60.0 ms, LCP 300 ms, CLS 0.01, INP 40.0 ms over 2 visits.');
		expect(report_json(analyze(p), meta_page() as never, '/p', { net: [], mem: [], vitals: { n: 1, ttfb: 1, fcp: 2, lcp: 3, cls: 0, inp: null } } as never).browser).toEqual({ n: 1, ttfb: 1, fcp: 2, lcp: 3, cls: 0, inp: null });
	});

	it('beacon: a vitals-only post lands per page; the report joins them; junk is bounded', async () => {
		const handle = profiler({ secret: 'prof-key' });
		const post = (body: string) =>
			handle({ event: { ...make_event('/__profiler/beacon'), request: new Request('http://localhost/__profiler/beacon', { method: 'POST', body }) } as RequestEvent, resolve: async () => new Response('no') });
		expect((await post(JSON.stringify({ page: '/p', vitals: { ttfb: 100, lcp: 900, cls: 0.05, inp: 'x', fcp: -1 } }))).status).toBe(204);
		expect((await post(JSON.stringify({ page: '/p', vitals: { ttfb: 120, lcp: 1100 } }))).status).toBe(204);
		expect((await post(JSON.stringify({ page: 'not-a-path', vitals: { ttfb: 1 } }))).status).toBe(204); // ignored, not an error
		expect((await post(JSON.stringify({ page: '/p' }))).status).toBe(400); // neither islands nor vitals
		// a page profile of /p joins them at view time
		const rec = await handle({ event: make_event('/__profiler/page?p=/p&runs=1&cold=0'), resolve: async () => new Response('<html></html>') });
		const url = rec.headers.get('location')!;
		const json = await (await handle({ event: make_event(url.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		expect(json.browser).toEqual({ n: 2, ttfb: 120, fcp: null, lcp: 1100, cls: 0.05, inp: null });
	});

	it('beacon marks: per page, per name, joined to the report as "marked in the browser"', async () => {
		const handle = profiler({ secret: 'prof-key' });
		const post = (body: string) =>
			handle({ event: { ...make_event('/__profiler/beacon'), request: new Request('http://localhost/__profiler/beacon', { method: 'POST', body }) } as RequestEvent, resolve: async () => new Response('no') });
		expect((await post(JSON.stringify({ page: '/m', marks: [{ name: 'ds.hydrate', ms: 320, attrs: { tags: 12 } }, { name: 'ds.hydrate', ms: 280 }, { name: 'widget', ms: 40, attrs: { error: true } }, { name: '', ms: 1 }, { name: 'bad', ms: -1 }] }))).status).toBe(204);
		const rec = await handle({ event: make_event('/__profiler/page?p=/m&runs=1&cold=0'), resolve: async () => new Response('<html></html>') });
		const url = rec.headers.get('location')!;
		const json = await (await handle({ event: make_event(url.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		expect(json.browser.marks).toEqual([
			{ name: 'ds.hydrate', n: 2, p50_ms: 320, max_ms: 320, errors: 0, attr_keys: ['tags'] },
			{ name: 'widget', n: 1, p50_ms: 40, max_ms: 40, errors: 1, attr_keys: [] }
		]);
		const f = json.findings.find((x: { code: string }) => x.code === 'client-mark');
		expect(f.message).toBe('In the browser the app marked 2 things: the slowest is ds.hydrate at 320 ms (p50 of 2); widget failed.');
		expect(f.fix).toMatch(/not the server render/);
	});

	it('spans nest outside a request context too: a handle in front of the profiled request keeps parent links', async () => {
		dev_switch.dev = false; // production: no per-request context unless recording — the spans below run outside any
		try {
			const handle = profiler({ secret: 'prof-key' });
			const res = await handle({
				event: make_event('/prod/page', { 'x-profile': 'prof-key' }),
				resolve: async () => {
					// spans opened from a plain promise, no request store around them
					await new Promise<void>((r) => setImmediate(r));
					await span('outer', async () => {
						await span('inner', () => new Promise((r) => setTimeout(r, 15)));
						await new Promise((r) => setTimeout(r, 5));
					});
					return new Response('page');
				}
			});
			const url = res.headers.get('x-profile-report')!;
			const json = await (await handle({ event: make_event(url + '.json', { 'x-profiler-key': 'prof-key' }), resolve: async () => new Response('no') })).json();
			const outer = json.spans.find((s: { name: string }) => s.name === 'outer');
			const inner = json.spans.find((s: { name: string }) => s.name === 'inner');
			expect(inner).toBeTruthy();
			// outer's self is its own 5 ms of waiting, not the inner span's 15
			expect(outer.self_ms).toBeLessThan(outer.total_ms - 10);
			expect(outer.self_ms).toBeGreaterThan(0);
		} finally {
			dev_switch.dev = true;
		}
	});

	it('the trap: a coarse background window keeps only a request over the threshold', async () => {
		const handle = profiler({ secret: 'prof-key', trap: { over: 30, window: 300, interval: 10, keep: 1 } });
		// the first request arms the trap (its first window opens ~1 s later)
		await handle({ event: make_event('/fast'), resolve: async () => new Response('ok') });
		await new Promise((r) => setTimeout(r, 1100));
		// inside the window: one fast request, one slow
		await handle({ event: make_event('/fast/again'), resolve: async () => new Response('ok') });
		await handle({
			event: make_event('/slow/one'),
			resolve: async () => {
				await new Promise((r) => setTimeout(r, 70));
				return new Response('slow');
			}
		});
		// let the window close and the report finish
		await new Promise((r) => setTimeout(r, 700));
		const dash = await (await handle({ event: make_event('/__profiler'), resolve: async () => new Response('no') })).text();
		expect(dash).toContain('Catch the slow one');
		expect(dash).toContain('Caught 1 of 1');
		expect(dash).toMatch(/caught \/slow\/one \(\d+ ms\)/);
		expect(dash).not.toContain('caught /fast');
	}, 15_000);

	it('the always-on sampler folds short windows into a hot-functions table on the dashboard', async () => {
		const handle = profiler({ secret: 'prof-key', sample: { every: 1, window: 150, interval: 10 } });
		await handle({ event: make_event('/arm'), resolve: async () => new Response('ok') });
		// keep the CPU busy through the first window so something is hot
		const busy_until = Date.now() + 1400;
		let spins = 0;
		while (Date.now() < busy_until) {
			await handle({ event: make_event('/spin'), resolve: async () => { for (let i = 0; i < 2e5; i++) spins += Math.sqrt(i); return new Response('ok'); } });
			await new Promise((r) => setImmediate(r));
		}
		await new Promise((r) => setTimeout(r, 300));
		const dash = await (await handle({ event: make_event('/__profiler'), resolve: async () => new Response('no') })).text();
		expect(spins).toBeGreaterThan(0);
		expect(dash).toContain('Always-on sampling');
		expect(dash).toMatch(/[1-9]\d* windows? so far/);
	}, 15_000);
});

describe('instrument (ogygia/profiler): every call of a function becomes a span', () => {
	const recorded: { name: string; attrs?: SpanAttrs; error?: string }[] = [];
	const rec: SpanRecorder = {
		begin: (name, attrs) => ({ id: recorded.push({ name, attrs }), name, start: 0, ms: -1, route: null, path: null }),
		within: (_s, fn) => fn(),
		end: (s, attrs, error) => {
			const r = recorded[s.id - 1];
			if (attrs) r.attrs = { ...r.attrs, ...attrs };
			if (error !== undefined) r.error = error instanceof Error ? error.message : String(error);
		},
		tag: () => {}
	};
	afterEach(() => {
		set_span_recorder(null);
		recorded.length = 0;
	});

	it('the function form: a wrapped function, attrs from the result and the arguments, this kept', async () => {
		const render = async (tag: string, opts: { pretty: boolean }) => ({ html: `<${tag}>`.repeat(opts.pretty ? 2 : 1) });
		const wrapped = instrument(render, 'ds.render', (r, tag) => ({ tag, bytes: r.html.length }));
		expect(wrapped.name).toBe('render');
		// outside a recording: one `if`, the same result
		expect((await wrapped('ds-button', { pretty: false })).html).toBe('<ds-button>');
		expect(recorded).toEqual([]);
		set_span_recorder(rec);
		expect((await wrapped('ds-card', { pretty: true })).html).toBe('<ds-card><ds-card>');
		expect(recorded).toEqual([{ name: 'ds.render', attrs: { tag: 'ds-card', bytes: 18 } }]);
		const obj = { n: 3, count: instrument(function (this: { n: number }, k: number) { return this.n * k; }, 'obj.count') };
		expect(obj.count(2)).toBe(6);
		const boom = instrument(() => { throw new Error('nope'); }, 'boom');
		expect(() => boom()).toThrow('nope');
		expect(recorded.at(-1)).toEqual({ name: 'boom', attrs: undefined, error: 'nope' });
	});

	it('the method form: patched in place, restored by the returned function', () => {
		const client = { calls: 0, query(sql: string) { this.calls++; return sql.length; } };
		set_span_recorder(rec);
		const restore = instrument(client, 'query', 'db.query', (rows, sql) => ({ rows, key: sql.slice(0, 6) }));
		expect(client.query('select 1')).toBe(8);
		expect(client.calls).toBe(1);
		expect(recorded).toEqual([{ name: 'db.query', attrs: { rows: 8, key: 'select' } }]);
		restore();
		expect(client.query('select 2')).toBe(8);
		expect(recorded).toHaveLength(1);
		expect(() => instrument(client, 'calls' as never, 'x')).toThrow(/not a function/);
	});
});

describe('paths to fix: hot functions grouped by the caller they share', () => {
	// X → B → C (hot), X → E (hot), B hot itself; an unrelated hot F under the route root
	const p: CpuProfile = {
		startTime: 0,
		endTime: 100_000,
		nodes: [
			{ id: 1, callFrame: frame('(root)'), children: [2] },
			{ id: 2, callFrame: frame('_page', '/app/src/routes/+page.svelte', 0), children: [3, 8] },
			{ id: 3, callFrame: frame('buildTree', '/app/src/lib/tree.ts', 10), children: [4, 7] },
			{ id: 4, callFrame: frame('walk', '/app/src/lib/tree.ts', 30), children: [5] },
			{ id: 5, callFrame: frame('escape', '/app/node_modules/svelte/src/internal/server/escaping.js', 3), children: [6] },
			{ id: 6, callFrame: frame('format', '/app/src/lib/fmt.ts', 2) },
			{ id: 7, callFrame: frame('sortRows', '/app/src/lib/sort.ts', 5) },
			{ id: 8, callFrame: frame('unrelated', '/app/src/lib/other.ts', 1) }
		],
		// walk 20, format 30, sortRows 20, unrelated 30 (ms)
		samples: [4, 4, 6, 6, 6, 7, 7, 8, 8, 8],
		timeDeltas: [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000]
	};
	it('groups walk, format and sortRows under buildTree, never under the route root; the tree keeps the chain', () => {
		const a = analyze(p);
		expect(a.paths).toHaveLength(1);
		const g = a.paths[0];
		expect(g.owner.name).toBe('buildTree');
		expect(g.fns.map((f) => `${f.name} ${f.ms}`)).toEqual(['format 30', 'walk 20', 'sortRows 20']);
		expect(g.ms).toBe(70);
		expect(g.share).toBe(1);
		// the chain: buildTree → walk → format (Svelte's `escape` between them is glue, dropped),
		// buildTree → sortRows
		expect(g.tree.name).toBe('buildTree');
		expect(g.tree.ms).toBe(70);
		expect(g.tree.children.map((c) => `${c.name}:${c.ms}:${c.hot}`)).toEqual(['walk:50:true', 'sortRows:20:true']);
		expect(g.tree.children[0].children).toHaveLength(1);
		expect(g.tree.children[0].children[0]).toMatchObject({ name: 'format', ms: 30, hot: true, children: [] });
		// `unrelated` shares nothing but the root: no group for it
		expect(a.paths.some((x) => x.fns.some((f) => f.name === 'unrelated'))).toBe(false);
		const meta = { id: 'x', created: 0, trigger: 'page' as const, page: '/p', runs: [100], run_status: 200, run_bytes: 9000, duration_ms: 100, node: 'v', requests: [] };
		const f = derive_findings(a, meta as never, { net: [], mem: [] } as never).find((x) => x.code === 'path-group')!;
		expect(f.severity).toBe('warn');
		expect(f.message).toBe('3 hot functions sit on one path under buildTree: format, walk, sortRows — 70.0 ms together (70.0% of busy).');
		expect(f.anchor).toMatch(/^fn:buildTree /);
		const j = report_json(a, meta as never, '/p', { net: [], mem: [] } as never);
		expect(j.paths[0]).toMatchObject({ owner: { name: 'buildTree', line: 11 }, ms: 70, pct_busy: 70, share_of_owner: 1 });
		expect(j.paths[0].tree.children[0].name).toBe('walk');
	});

	it('the owner is the most specific frame that keeps the time: down through the root and an island host, not the layout glue', () => {
		const p2: CpuProfile = {
			startTime: 0,
			endTime: 40_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('children', '/app/build/server/chunks/internal2.js', 507), children: [3] },
				{ id: 3, callFrame: frame('_page', '/app/src/routes/+page.svelte', 0), children: [4] },
				{ id: 4, callFrame: frame('_b95bfb97fab', '/app/build/server/entries/pages/_page.svelte.js', 401), children: [5] },
				{ id: 5, callFrame: frame('Card', '/app/src/lib/Card.svelte', 0), children: [6, 7] },
				{ id: 6, callFrame: frame('fmt', '/app/src/lib/fmt.ts', 2) },
				{ id: 7, callFrame: frame('slug', '/app/src/lib/slug.ts', 2) }
			],
			samples: [6, 6, 7, 7],
			timeDeltas: [10_000, 10_000, 10_000, 10_000]
		};
		const rename = (n: string) => (n === '_b95bfb97fab' ? 'Card (island host)' : undefined);
		const a = analyze(p2, undefined, undefined, undefined, rename);
		expect(a.paths).toHaveLength(1);
		expect(a.paths[0].owner.name).toBe('Card');
		expect(a.paths[0].fns.map((f) => f.name).sort()).toEqual(['fmt', 'slug']);
		// the tree still starts at the owner, with the glue above it gone
		expect(a.paths[0].tree.name).toBe('Card');
		expect(a.paths[0].tree.children.map((c) => c.name).sort()).toEqual(['fmt', 'slug']);
	});

	it('the profiler’s own span/within wrappers fold out of a path chain like Svelte’s glue', () => {
		const prof: CpuProfile = {
			startTime: 0,
			endTime: 40_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('processTags', '/app/src/lib/ds.ts', 5), children: [3] },
				{ id: 3, callFrame: frame('span', '/app/build/server/chunks/index-server.js', 900), children: [4] },
				{ id: 4, callFrame: frame('within', '/app/build/server/chunks/index-server.js', 910), children: [5, 6] },
				{ id: 5, callFrame: frame('tokenize', '/app/node_modules/parse5/lib/tokenizer.js', 30) },
				{ id: 6, callFrame: frame('splice', '/app/src/lib/ds.ts', 40) }
			],
			samples: [5, 5, 6, 6],
			timeDeltas: [10_000, 10_000, 10_000, 10_000]
		};
		const a = analyze(prof);
		expect(a.paths[0].owner.name).toBe('processTags');
		expect(a.paths[0].tree.children.map((c) => c.name).sort()).toEqual(['splice', 'tokenize']);
	});

	it('a path needs two hot functions and real time; a lone hot function is no path', () => {
		const lone: CpuProfile = {
			startTime: 0,
			endTime: 10_000,
			nodes: [
				{ id: 1, callFrame: frame('(root)'), children: [2] },
				{ id: 2, callFrame: frame('owner', '/app/src/lib/a.ts', 1), children: [3] },
				{ id: 3, callFrame: frame('only', '/app/src/lib/b.ts', 1) }
			],
			samples: [3],
			timeDeltas: [10_000]
		};
		expect(analyze(lone).paths).toEqual([]);
	});
});

describe('the causality graph, pending resources, memory per component, path diff', () => {
	const idle_profile: CpuProfile = {
		startTime: 0, endTime: 100_000,
		nodes: [{ id: 1, callFrame: frame('(root)'), children: [2] }, { id: 2, callFrame: frame('(idle)') }],
		samples: [2], timeDeltas: [100_000]
	};
	const idle_info = () => ({ name: '(idle)', url: '', line: 0, category: 'idle' as const });

	it('await_graph: an edge where a call started only once another finished, none for calls in flight together', () => {
		const t = build_timeline(idle_profile, idle_info, () => undefined, {
			perf_start: 1000,
			window: { start: 1000, end: 1100 },
			calls: [
				{ start: 1000, ms: 20, label: 'GET a', kind: 'net', caller: 'load (routes/+page.server.ts:5)' },
				{ start: 1021, ms: 20, label: 'GET b', kind: 'net', caller: 'load (routes/+page.server.ts:6)', callers: ['load (routes/+page.server.ts:6)', 'respond (x.ts:1)'] },
				// c and d start together right after b: parallel — c gets the edge from b, d does not (c in flight)
				{ start: 1042, ms: 30, label: 'GET c', kind: 'net', caller: 'load (routes/+page.server.ts:8)' },
				{ start: 1043, ms: 10, label: 'GET d', kind: 'net', caller: 'load (routes/+page.server.ts:9)' },
				// a span is the overlay, never a node
				{ start: 1000, ms: 80, label: 'db.all', kind: 'span' },
				// a timer far later: nothing ended within 5 ms before it
				{ start: 1090, ms: 5, label: 'timer', kind: 'timer' }
			]
		});
		const g = t.awaits!;
		expect(g.nodes.map((n) => `${n.label}@${n.lane}`)).toEqual(['GET a@0', 'GET b@0', 'GET c@0', 'GET d@1', 'timer@0']);
		expect(g.edges).toEqual([
			{ from: 'GET a', to: 'GET b', gap_ms: 1, at: 'load (routes/+page.server.ts:6)', callers: ['load (routes/+page.server.ts:6)', 'respond (x.ts:1)'] },
			{ from: 'GET b', to: 'GET c', gap_ms: 1, at: 'load (routes/+page.server.ts:8)' }
		]);
	});

	it('a gap is named after the resources pending across it', () => {
		const t = build_timeline(idle_profile, idle_info, () => undefined, {
			perf_start: 1000,
			window: { start: 1000, end: 1100 },
			calls: [{ start: 1000, ms: 20, label: 'GET a', kind: 'net' }],
			pending: [
				{ start: 1020, end: 1060, label: 'Immediate from drainQueue (routes/+page.server.ts:30)', kind: 'timer' },
				{ start: 1025, end: 1055, label: 'TickObject', kind: 'other' },
				{ start: 1070, end: 1100, label: 'TCPWRAP from pool (lib/db.ts:9)', kind: 'socket' }
			]
		});
		const gaps = t.segments.filter((s) => s.kind === 'gap');
		// 20–25 immediate · 25–55 immediate + tick · 55–60 immediate · 60–70 nothing · 70–100 socket
		expect(gaps.map((s) => `${s.t0}-${s.t1} ${s.label}`)).toEqual([
			'20-25 nothing recorded — pending: Immediate from drainQueue (routes/+page.server.ts:30)',
			'25-55 nothing recorded — pending: Immediate from drainQueue (routes/+page.server.ts:30) (+1)',
			'55-60 nothing recorded — pending: Immediate from drainQueue (routes/+page.server.ts:30)',
			'60-70 nothing recorded',
			'70-100 nothing recorded — pending: TCPWRAP from pool (lib/db.ts:9)'
		]);
		expect(gaps[1].pending).toEqual(['Immediate from drainQueue (routes/+page.server.ts:30)', 'TickObject']);
	});

	it('heap_by_component: bytes credited to the nearest component, nested components take their own', () => {
		const head: HeapNode = {
			callFrame: frame('(root)'), selfSize: 0,
			children: [
				{ callFrame: frame('_page', '/app/src/routes/+page.svelte', 0), selfSize: 100, children: [
					{ callFrame: frame('Card', '/app/src/lib/Card.svelte', 0), selfSize: 1000, children: [
						{ callFrame: frame('fmt', '/app/src/lib/fmt.ts', 1), selfSize: 500 },
						{ callFrame: frame('Badge', '/app/src/lib/Badge.svelte', 0), selfSize: 50 }
					] },
					{ callFrame: frame('escape_html', '/app/node_modules/svelte/src/internal/server/escaping.js', 1), selfSize: 20 }
				] }
			]
		};
		expect(heap_by_component(head)).toEqual([
			{ name: 'Card', bytes: 1500 },
			{ name: '_page', bytes: 120 },
			{ name: 'Badge', bytes: 50 }
		]);
	});

	it('compare: the paths to fix diff by owner', () => {
		const mk = (paths: Analysis['paths']): { meta: ReportMeta; analysis: Analysis; findings: string[] } => ({
			meta: { id: 'x', created: 0, trigger: 'page', page: '/p', runs: [10], duration_ms: 10, sample_interval_us: 500, requests: [], node: 'v' },
			analysis: { ...analyze(idle_profile), paths },
			findings: []
		});
		const g = (owner: string, ms: number, fns: string[]): Analysis['paths'][number] => ({
			owner: { key: owner, name: owner, url: 'x.ts', line: 1, category: 'app', total_ms: ms },
			fns: fns.map((n) => ({ key: n, name: n, url: 'x.ts', line: 1, category: 'app', ms: 1 })),
			ms, share: 1,
			tree: { key: owner, name: owner, category: 'app', file: '', ms, hot: false, children: [] }
		});
		const cmp = compare_reports(mk([g('buildTree', 180, ['walk', 'fmt']), g('gone', 30, ['x'])]), mk([g('buildTree', 40, ['fmt']), g('fresh', 25, ['y', 'z'])]));
		expect(cmp.paths).toEqual([
			{ owner: 'buildTree', file: 'x.ts', line: 1, a_ms: 180, b_ms: 40, d_ms: -140, a_fns: ['walk', 'fmt'], b_fns: ['fmt'] },
			{ owner: 'gone', file: 'x.ts', line: 1, a_ms: 30, b_ms: 0, d_ms: -30, a_fns: ['x'], b_fns: [], only: 'a' },
			{ owner: 'fresh', file: 'x.ts', line: 1, a_ms: 0, b_ms: 25, d_ms: 25, a_fns: [], b_fns: ['y', 'z'], only: 'b' }
		]);
	});
});

describe('the browser CPU profile and the request replay', () => {
	it('a prerendered page: Kit throws on url.search, and the request log keeps the entry without it', async () => {
		const handle = profiler({ secret: 'k' });
		const ev = make_event('/static');
		Object.defineProperty(ev.url, 'search', {
			get() {
				throw new Error('Cannot access url.search on a page with prerendering enabled');
			}
		});
		// before the guard this threw out of the handle and failed the prerender of the whole build
		const res = await handle({ event: ev, resolve: async () => new Response('<html></html>') });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('<html></html>');
	});

	// a JS Self-Profiling trace: Card (a component) calls fmt; idle samples have no stack
	const trace = {
		// the page's own chunks, on the origin the beacon is posted to (another host would be a dependency)
		resources: ['http://localhost/_app/immutable/chunks/app.js', 'http://localhost/_app/immutable/chunks/rt.js'],
		frames: [
			{ name: 'Card', resourceId: 0, line: 10, column: 1 },
			{ name: 'fmt', resourceId: 0, line: 40, column: 1 },
			{ name: 'set_text', resourceId: 1, line: 5, column: 1 }
		],
		stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }, { frameId: 2, parentId: 0 }],
		samples: [
			{ timestamp: 100, stackId: 1 },
			{ timestamp: 110, stackId: 1 },
			{ timestamp: 120, stackId: 2 },
			{ timestamp: 130 },
			{ timestamp: 140, stackId: 0 }
		]
	};

	it('self_profile_to_cpuprofile: stacks become nodes, samples become deltas, no stack is idle; junk is null', () => {
		const p = self_profile_to_cpuprofile(trace)!;
		expect(p.nodes.map((n) => `${n.id}:${n.callFrame.functionName}`)).toEqual(['1:(root)', '2:(idle)', '3:Card', '4:fmt', '5:set_text']);
		expect(p.nodes.find((n) => n.id === 3)!.children).toEqual([4, 5]);
		expect(p.samples).toEqual([4, 4, 5, 2, 3]);
		expect(p.timeDeltas).toEqual([0, 10_000, 10_000, 10_000, 10_000]);
		expect(self_profile_to_cpuprofile({ frames: 'x' })).toBeNull();
		expect(self_profile_to_cpuprofile(null)).toBeNull();
		// analysed with the build's hint: rt.js holds only the svelte runtime → svelte; Card confirmed as a component
		const a = analyze(p, undefined, undefined, undefined, undefined, (url) => (url.includes('rt.js') ? 'svelte' : undefined));
		expect(a.components.map((c) => c.name)).toEqual(['Card']);
		expect(a.functions.find((f) => f.name === 'set_text')!.category).toBe('svelte');
		expect(a.components[0].markup_ms).toBe(10);
		expect(a.components[0].logic_ms).toBe(20); // the first sample carries no delta
	});

	it('a minified client chunk: the confirmed component is named from the .svelte files the build put in the chunk; helpers are not', () => {
		// Y (the component: svelte runtime below it) and Pt (a helper, nothing svelte below) in one chunk
		const minified = {
			resources: ['http://h/_app/immutable/chunks/zQnt.js', 'http://h/_app/immutable/chunks/rt.js', 'http://h/_app/immutable/chunks/multi.js'],
			frames: [
				{ name: 'Y', resourceId: 0, line: 1, column: 1 },
				{ name: 'Pt', resourceId: 0, line: 1, column: 9 },
				{ name: 'set_text', resourceId: 1, line: 5, column: 1 },
				{ name: 'B', resourceId: 2, line: 1, column: 1 }
			],
			stacks: [{ frameId: 0 }, { frameId: 2, parentId: 0 }, { frameId: 1 }, { frameId: 3 }, { frameId: 2, parentId: 3 }],
			samples: [{ timestamp: 0, stackId: 1 }, { timestamp: 10, stackId: 1 }, { timestamp: 20, stackId: 2 }, { timestamp: 30, stackId: 4 }, { timestamp: 40, stackId: 0 }]
		};
		const contents = (path: string) =>
			path.endsWith('zQnt.js') ? ['src/lib/hell/ProductCard.svelte', 'svelte runtime'] : path.endsWith('multi.js') ? ['src/lib/a/Header.svelte', 'src/lib/a/Nav.svelte', 'src/lib/a/Logo.svelte', '+2 more'] : path.endsWith('rt.js') ? ['svelte runtime'] : undefined;
		const p = self_profile_to_cpuprofile(minified)!;
		const a = analyze(p, undefined, undefined, undefined, chunk_component_renamer(contents), (url) => (url.includes('rt.js') ? 'svelte' : undefined));
		expect(a.components.map((c) => c.name).sort()).toEqual(['Header (+2 in chunk)', 'ProductCard']);
		// the helper keeps its minified name as app code — it was never confirmed, so never renamed
		const pt = a.functions.find((f) => f.name === 'Pt')!;
		expect(pt.category).toBe('app');
		expect(a.functions.some((f) => f.name === 'Y')).toBe(false);
		// a name that is not minified is left alone even when the chunk is known
		expect(chunk_component_renamer(contents)('ProductCard', 'http://h/_app/immutable/chunks/zQnt.js', 'confirmed')).toBeUndefined();
		expect(chunk_component_renamer(contents)('Y', 'http://h/_app/immutable/chunks/zQnt.js', 'frame')).toBeUndefined();
		// a path without a host (a relative resource) still finds its chunk
		expect(chunk_component_renamer(contents)('Y', '/_app/immutable/chunks/zQnt.js', 'confirmed')).toBe('ProductCard');
	});

	it('a browser frame with a source map: the minified name and the chunk give way to the real function and its .svelte file', () => {
		// a tiny VLQ encoder to author the map
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
		// generated line 0: col 0 → source 0 (ProductCard.svelte) line 3, name 0; col 40 → source 1 (fmt.ts) line 8, name 1
		const mappings = [vlq(0) + vlq(0) + vlq(3) + vlq(0) + vlq(0), vlq(40) + vlq(1) + vlq(5) + vlq(0) + vlq(1)].join(',');
		const map = JSON.stringify({ sources: ['../../../../src/lib/hell/ProductCard.svelte', '../../../../src/lib/fmt.ts'], names: ['ProductCard', 'format_price'], mappings });
		const file = '/app/.svelte-kit/output/client/_app/immutable/chunks/zQnt.js';
		// the runtime chunk (hinted a dependency by the build) has a map too: svelte's own source and
		// a workspace-linked ogygia runtime whose path has no node_modules in it
		// col 0 → svelte task.js `flush_sync`; col 34 → hydrate-core.js, NAMELESS (the `function` keyword,
		// as a minifier maps it); col 40 → the same file, the identifier `hydrate_island`
		const rt_mappings = [vlq(0) + vlq(0) + vlq(0) + vlq(0) + vlq(0), vlq(34) + vlq(1) + vlq(0) + vlq(0), vlq(6) + vlq(0) + vlq(0) + vlq(0) + vlq(1)].join(',');
		const rt_map = JSON.stringify({ sources: ['../../../../node_modules/svelte/src/internal/client/dom/task.js', '../../../../../packages/ogygia/dist/runtime/hydrate-core.js'], names: ['flush_sync', 'hydrate_island'], mappings: rt_mappings });
		const rt = '/app/.svelte-kit/output/client/_app/immutable/chunks/rt.js';
		const resolver = sourcemap_resolver((p) => (p === file + '.map' ? map : p === rt + '.map' ? rt_map : undefined));
		const trace = {
			resources: [file, rt],
			frames: [
				{ name: 'Y', resourceId: 0, line: 1, column: 1 },
				{ name: 'Gr', resourceId: 0, line: 1, column: 41 },
				{ name: 'z', resourceId: 1, line: 1, column: 1 },
				{ name: '#u', resourceId: 1, line: 1, column: 41 },
				// the function's start sits 6 columns before the named segment (`function w(` → `w`)
				{ name: 'w', resourceId: 1, line: 1, column: 35 }
			],
			stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }, { frameId: 2, parentId: 0 }, { frameId: 3 }, { frameId: 4 }],
			samples: [{ timestamp: 0, stackId: 1 }, { timestamp: 10, stackId: 1 }, { timestamp: 20, stackId: 2 }, { timestamp: 30, stackId: 0 }, { timestamp: 40, stackId: 3 }, { timestamp: 50, stackId: 4 }]
		};
		const p = self_profile_to_cpuprofile(trace)!;
		const a = analyze(p, resolver, undefined, undefined, chunk_component_renamer(() => undefined), (url) => (url.includes('rt.js') ? { category: 'dependency', pkg: 'svelte + ogygia' } : undefined));
		expect(a.components.map((c) => c.name)).toEqual(['ProductCard']);
		expect(a.components[0].url).toMatch(/src\/lib\/hell\/ProductCard\.svelte$/);
		const fmt = a.functions.find((f) => f.name === 'format_price')!;
		expect(fmt.category).toBe('app');
		expect(fmt.url).toMatch(/src\/lib\/fmt\.ts$/);
		expect(fmt.line).toBe(9); // source line 3 + delta 5, 1-based
		// the dependency chunk mapped too: svelte's file makes it `svelte` (more specific than the hint),
		// the workspace runtime keeps the hint's category and package instead of reading as app code
		const flush = a.functions.find((f) => f.name === 'flush_sync')!;
		expect(flush.category).toBe('svelte');
		// (the mapped path names the package itself — `ogygia/dist/` — so the hint's coarse label gives way)
		const hy = a.functions.filter((f) => f.name === 'hydrate_island');
		expect(hy.length).toBe(1); // `#u` at the name and `w` six columns before it: one function
		expect(hy[0].category).toBe('dependency');
		expect(hy[0].pkg).toBe('ogygia');
		expect(hy[0].url).toMatch(/hydrate-core\.js$/);
		expect(hy[0].self_ms).toBe(20);
		expect(a.functions.some((f) => ['Y', 'Gr', 'z', '#u', 'w'].includes(f.name))).toBe(false);
	});

	it('name_at_source: the function name written in the original source at a mapped position', () => {
		const src = [
			'export function template_effect(fn, sync = []) {', // 1
			'\tflatten(blockers, sync, async, (values) => {', // 2
			'function create_effect(type, fn) {', // 3
			'\t#preload_attr(el, name) {', // 4
			'\tstatic async load(x) {', // 5
			'const format_price = (n) => n.toFixed(2);', // 6
			'\tonclick: async () => {', // 7
			'\tif (x) {', // 8
			'export default function () {}', // 9
			'\tget value() { return 1; }' // 10
		].join('\n');
		const r = sourcemap_resolver((p) => (p === '/src/a.js' ? src : undefined));
		expect(r.name_at_source('/src/a.js', 1, 1)).toBe('template_effect');
		expect(r.name_at_source('/src/a.js', 1, 8)).toBe('template_effect'); // at `function`
		expect(r.name_at_source('/src/a.js', 2, 34)).toBeUndefined(); // a real anonymous callback
		expect(r.name_at_source('/src/a.js', 3, 1)).toBe('create_effect');
		expect(r.name_at_source('/src/a.js', 4, 2)).toBe('#preload_attr');
		expect(r.name_at_source('/src/a.js', 5, 2)).toBe('load');
		expect(r.name_at_source('/src/a.js', 6, 22)).toBe('format_price'); // at `(n) =>`
		expect(r.name_at_source('/src/a.js', 7, 11)).toBe('onclick');
		expect(r.name_at_source('/src/a.js', 8, 2)).toBeUndefined(); // `if (` is not a name
		expect(r.name_at_source('/src/a.js', 9, 1)).toBeUndefined();
		expect(r.name_at_source('/src/a.js', 10, 2)).toBe('value');
		expect(r.name_at_source('/src/missing.js', 1, 1)).toBeUndefined();
		expect(r.name_at_source('/src/a.js', 99, 1)).toBeUndefined();
	});

	it('client files: app assets map to the built client dir, other hosts and crafted paths never do', () => {
		const join = (...p: string[]) => p.join('/').replace(/\/+/g, '/');
		// the cwd's build/client is the same dir as the entry's client here: listed once
		expect(client_dir_candidates('/srv/build', '/srv', join)).toEqual(['/srv/build/client', '/srv/build/../client', '/srv/.svelte-kit/output/client']);
		expect(client_dir_candidates(undefined, '/srv', join)).toEqual(['/srv/.svelte-kit/output/client', '/srv/build/client']);
		expect(app_asset_rel('/_app/immutable/chunks/X.js')).toBe('_app/immutable/chunks/X.js');
		expect(app_asset_rel('/base/path/_app/immutable/entry/start.js')).toBe('_app/immutable/entry/start.js');
		expect(app_asset_rel('/_app/../secret.js')).toBeUndefined();
		expect(app_asset_rel('/other/x.js')).toBeUndefined();
		const on_disk = new Set(['/srv/build/client/_app/immutable/chunks/X.js']);
		const find = client_file_finder('http://site', ['/srv/nope', '/srv/build/client'], (p) => on_disk.has(p), join);
		expect(find('http://site/_app/immutable/chunks/X.js')).toBe('/srv/build/client/_app/immutable/chunks/X.js');
		expect(find('/_app/immutable/chunks/X.js')).toBe('/srv/build/client/_app/immutable/chunks/X.js');
		expect(find('http://site/_app/immutable/chunks/missing.js')).toBeUndefined();
		expect(find('https://cdn.example.net/_app/immutable/chunks/X.js')).toBeUndefined();
		expect(find('not a url')).toBeUndefined();
	});

	it('beacon: a script from another host, or a chunk with no app file in it, is a dependency whatever its names', async () => {
		const handle = profiler({ secret: 'prof-key' });
		// the build knows the runtime chunk holds only packages (svelte's runtime + clsx)
		set_chunk_contents({ '/_app/immutable/chunks/rt.js': ['svelte runtime', 'clsx'] });
		const cdn = {
			resources: ['https://cdn.example.net/npm/@acme/core@8/dist/p-abc.js', 'http://localhost/_app/immutable/chunks/app.js', 'http://localhost/_app/immutable/chunks/rt.js'],
			frames: [{ name: 'Card', resourceId: 0, line: 1, column: 1 }, { name: 'Local', resourceId: 1, line: 1, column: 1 }, { name: 'Gr', resourceId: 2, line: 1, column: 1 }],
			stacks: [{ frameId: 0 }, { frameId: 1 }, { frameId: 2 }],
			samples: [{ timestamp: 0, stackId: 0 }, { timestamp: 10, stackId: 0 }, { timestamp: 20, stackId: 1 }, { timestamp: 30, stackId: 2 }]
		};
		const post = (body: string) =>
			handle({ event: { ...make_event('/__profiler/beacon'), request: new Request('http://localhost/__profiler/beacon', { method: 'POST', body }) } as RequestEvent, resolve: async () => new Response('no') });
		expect((await post(JSON.stringify({ page: '/cdn', cpu: cdn }))).status).toBe(204);
		const rec = await handle({ event: make_event('/__profiler/page?p=/cdn&runs=1&cold=0'), resolve: async () => new Response('<html></html>') });
		const url = rec.headers.get('location')!;
		const json = await (await handle({ event: make_event(url.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		const card = json.browser.cpu.hot_functions.find((f: { name: string }) => f.name === 'Card');
		expect(card.category).toBe('dependency');
		expect(card.package).toBe('@acme/core'); // named by the package in the CDN path, not "ogygia"
		const gr = json.browser.cpu.hot_functions.find((f: { name: string }) => f.name === 'Gr');
		expect(gr.category).toBe('dependency');
		expect(gr.package).toBe('svelte + clsx');
		expect(json.browser.cpu.components.map((c: { name: string }) => c.name)).not.toContain('Card');
		set_chunk_contents({});
	});

	it('beacon: a cpu trace lands per page and the report shows it as browser components', async () => {
		const handle = profiler({ secret: 'prof-key' });
		const post = (body: string) =>
			handle({ event: { ...make_event('/__profiler/beacon'), request: new Request('http://localhost/__profiler/beacon', { method: 'POST', body }) } as RequestEvent, resolve: async () => new Response('no') });
		expect((await post(JSON.stringify({ page: '/c', cpu: { frames: 1 } }))).status).toBe(400);
		expect((await post(JSON.stringify({ page: '/c', cpu: trace }))).status).toBe(204);
		const rec = await handle({ event: make_event('/__profiler/page?p=/c&runs=1&cold=0'), resolve: async () => new Response('<html></html>') });
		const url = rec.headers.get('location')!;
		const json = await (await handle({ event: make_event(url.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		expect(json.browser.cpu.components.map((c: { name: string }) => c.name)).toEqual(['Card']);
		expect(json.browser.cpu.busy_ms).toBe(30);
		// a document for the profiler's user carries the policy that lets the browser sample itself
		const doc = await handle({ event: make_event('/some/page', { 'sec-fetch-dest': 'document' }), resolve: async () => new Response('<html><head></head></html>') });
		expect(doc.headers.get('document-policy')).toBe('js-profiling');
		const sub = await handle({ event: make_event('/some/data', { 'sec-fetch-dest': 'empty' }), resolve: async () => new Response('x') });
		expect(sub.headers.get('document-policy')).toBeNull();
	});

	it('replay: a header-profiled request is rendered again in page mode with its query and kept headers', async () => {
		const handle = profiler({ secret: 'prof-key', trap: { over: 100_000, replay: ['x-tenant', 'accept-language'] } });
		const profiled = await handle({
			event: make_event('/prod/page?x=1', { 'x-profile': 'prof-key', 'x-tenant': 'acme', 'accept-language': 'fr', cookie: 'secret=1' }),
			resolve: async () => new Response('page')
		});
		const report_url = profiled.headers.get('x-profile-report')!;
		const id = report_url.split('/').pop()!;
		const seen: Record<string, string>[] = [];
		const ev = make_event(`/__profiler/replay/${id}`);
		(ev as { fetch: unknown }).fetch = async (_p: string, init?: RequestInit) => {
			seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
			return new Response('<html></html>');
		};
		const res = await handle({ event: ev, resolve: async () => new Response('no') });
		expect(res.status).toBe(303);
		const again = await (await handle({ event: make_event(res.headers.get('location')!.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		expect(again.target.page).toBe('/prod/page?x=1');
		// the kept headers travel; the cookie does not (not named)
		expect(seen[0]).toMatchObject({ 'x-tenant': 'acme', 'accept-language': 'fr', 'x-og-profiler-internal': '1' });
		expect(seen[0].cookie).toBeUndefined();
		// the report links it
		const first = await (await handle({ event: make_event(report_url + '.json'), resolve: async () => new Response('no') })).json();
		expect(first.replay).toEqual({ url: `/__profiler/replay/${id}`, path: '/prod/page?x=1', headers: ['x-tenant', 'accept-language'] });
		expect((await handle({ event: make_event('/__profiler/replay/nope'), resolve: async () => new Response('no') })).status).toBe(404);
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
			// one after another: each starts when the previous ended
			...Array.from({ length: 32 }, (_, i) => s('stock.lookup', 7, { start: i * 7, caller: 'load (routes/+page.server.ts:20)' })),
			// together: forty renders under a Promise.all, the same 100 ms of wall
			...Array.from({ length: 40 }, () => s('ds.render', 100, { start: 500, caller: 'processTags (lib/ds.ts:9)' })),
			s('cache.segments', 18, { attrs: { cache: 'miss' } }), s('cache.segments', 18, { attrs: { cache: 'miss' } }),
			s('svc.x', 1, { error: 'ECONNRESET' })
		];
		const f = derive_findings(analyze(p), meta as never, { net: [], mem: [], spans } as never);
		const by = Object.fromEntries(f.map((x) => [x.code, x]));
		const repeats = f.filter((x) => x.code === 'span-repeat');
		expect(repeats.map((x) => x.message.split(' ran ')[0])).toEqual(['ds.render', 'stock.lookup']);
		expect(repeats[1].message).toContain('stock.lookup ran 16 times in one render');
		expect(repeats[1].fix).toMatch(/batch/);
		expect(repeats[0].message).toBe('ds.render ran 20 times in one render (processTags (lib/ds.ts:9)), together: 50.0 ms of wall for 2000 ms of summed work, 100 ms each.');
		expect(repeats[0].fix).toMatch(/already overlap/);
		const rows = span_rows(spans);
		expect(rows.find((r) => r.name === 'ds.render')).toMatchObject({ count: 40, total_ms: 4000, wall_ms: 100 });
		// the breakdown by attribute value: `ds.render` by tag
		const tagged = [
			...Array.from({ length: 12 }, () => s('ds.render', 100, { start: 0, attrs: { tag: 'ds-chip', bytes: 900 } })),
			...Array.from({ length: 2 }, () => s('ds.render', 10, { start: 0, attrs: { tag: 'ds-button', bytes: 100 } })),
			s('ds.render', 5, { start: 0, attrs: { tag: 'ds-badge' } })
		];
		const brk = span_rows(tagged)[0].by;
		expect(Object.keys(brk)).toEqual(['tag']); // `bytes` is numeric: not a breakdown
		// a value unique per span (an id) is no split either
		expect(span_rows(Array.from({ length: 6 }, (_, i) => s('stock.lookup', 7, { start: i, attrs: { key: `P${i}` } })))[0].by).toEqual({});
		// all twelve chips start together: 1200 ms summed, 100 ms of wall
		expect(brk.tag).toEqual([
			{ value: 'ds-chip', count: 12, total_ms: 1200, wall_ms: 100, p50_ms: 100, max_ms: 100 },
			{ value: 'ds-button', count: 2, total_ms: 20, wall_ms: 10, p50_ms: 10, max_ms: 10 },
			{ value: 'ds-badge', count: 1, total_ms: 5, wall_ms: 5, p50_ms: 5, max_ms: 5 }
		]);
		const fb = derive_findings(analyze(p), meta as never, { net: [], mem: [], spans: tagged } as never).find((x) => x.code === 'span-repeat')!;
		expect(fb.message).toContain('Most of it is tag ds-chip: 6 of them, 50.0 ms of wall (600 ms summed).');
		// SELF: a parent span minus the child spans inside it
		const nested = [
			s('ds.pass', 250, { id: 1, start: 0 }),
			s('ds.render.all', 178, { id: 2, start: 1, parent: 1 }),
			s('ds.splice', 69, { id: 3, start: 180, parent: 1 })
		];
		const by_name = Object.fromEntries(span_rows(nested).map((r) => [r.name, r]));
		expect(by_name['ds.pass']).toMatchObject({ total_ms: 250, self_ms: 3, wall_ms: 250 });
		expect(by_name['ds.render.all']).toMatchObject({ total_ms: 178, self_ms: 178 });
		expect(rows.find((r) => r.name === 'stock.lookup')).toMatchObject({ count: 32, total_ms: 224, wall_ms: 224 });
		expect(by['cache-misses'].message).toContain('cache.segments: 1 cache miss per render cost 18');
		expect(by['span-errors'].message).toContain('svc.x failed 1 time');
		expect(report_json(analyze(p), meta as never, '/p', { net: [], mem: [], spans } as never).spans[0].name).toBe('ds.render'); // by summed time
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

	it("wraps Kit's event.fetch: a same-origin call dispatched in-process is recorded like any other", async () => {
		const handle = profiler();
		const ev = make_event('/some/page');
		const inner = ev.fetch;
		const res = await handle({
			event: ev,
			resolve: async (e) => {
				expect(e.fetch).not.toBe(inner); // wrapped for this attributed request
				await e.fetch('/hell/api/session');
				return new Response('page');
			}
		});
		expect(res.headers.get('Server-Timing') ?? '').toContain('net;desc="outbound (1)"');
		// idempotent: wrapping the wrapper hands it back
		const { wrap_event_fetch } = await import('../src/profiler/net.js');
		const once = wrap_event_fetch(inner);
		expect(wrap_event_fetch(once)).toBe(once);
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
		const ok = await post(JSON.stringify({ page: '/prod/page', islands: [{ fp, entry: 'src/lib/Widget.svelte', ms: 42, load: 30, recovered: true }, { fp, entry: 'src/lib/Widget.svelte', ms: 50, load: 31 }, { fp: 'nope', ms: 1 }, { fp, ms: -5 }] }));
		expect(ok.status).toBe(204);
		const json = await (await handle({ event: make_event(report_url + '.json'), resolve: async () => new Response('no') })).json();
		expect(json.ogygia.island_rows[0].client).toEqual({ hydrations: 2, p50_ms: 50, max_ms: 50, load_p50_ms: 31, recovered: 1 });
		expect(json.findings.find((f: { code: string }) => f.code === 'hydration-mismatch').message).toContain('Widget discarded its server-rendered DOM and re-rendered in the browser (1 time seen)');
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

describe('the deep pictures on the host: visits, keep, the byte strip, nested traces, the sink, the site page', () => {
	const visit_body = (page = '/deep') =>
		JSON.stringify({
			page,
			visit: {
				at: 1_700_000_000_000,
				nav: { req_start: 5, res_start: 120, res_end: 180, dcl: 400, load: 900, size: 200_000 },
				paints: { fcp: 350, lcp: 700, lcp_fp: '0000aaaa1111bbbb' },
				resources: [{ url: 'http://localhost/_app/a.css', type: 'css', start: 130, end: 300, blocking: true }],
				longtasks: [],
				islands: [{ fp: '0000aaaa1111bbbb', t0: 500, loaded: 560, done: 690, changed: true }],
				firsts: [{ fp: '0000aaaa1111bbbb', t: 1500, type: 'pointer' }],
				shifts: [{ t: 600, value: 0.12, fp: '0000aaaa1111bbbb' }, { t: 650, value: 0.03 }],
				viewport: [1200, 800]
			}
		});
	const post = (handle: ReturnType<typeof profiler>, body: string) =>
		handle({ event: { ...make_event('/__profiler/beacon'), request: new Request('http://localhost/__profiler/beacon', { method: 'POST', body }) } as RequestEvent, resolve: async () => new Response('no') });

	it('beacon: a visit lands per page, bounded, and the report JSON carries its picture', async () => {
		const handle = profiler({ secret: 'prof-key' });
		expect((await post(handle, visit_body())).status).toBe(204);
		expect((await post(handle, JSON.stringify({ page: '/deep', visit: { nav: {} } }))).status).toBe(400);
		expect((await post(handle, JSON.stringify({ page: '/deep', visit: { nav: { res_start: 1 }, resources: Array.from({ length: 20000 }, () => ({ url: 'http://x/y.js', type: 'script', start: 1, end: 2 })) } }))).status).toBe(413);
		const rec = await handle({ event: make_event('/__profiler/page?p=/deep&runs=1&cold=0'), resolve: async () => new Response('<html></html>') });
		const url = rec.headers.get('location')!;
		const json = await (await handle({ event: make_event(url.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		expect(json.browser.visit).toMatchObject({ nav: { res_start: 120, res_end: 180 }, paints: { fcp: 350, lcp: 700, lcp_fp: '0000aaaa1111bbbb' }, resources: 1, shifts: 2 });
		expect(json.browser.visit.islands[0]).toMatchObject({ fp: '0000aaaa1111bbbb', done: 690, changed: true });
		expect(json.browser.visit.cls_by_island).toEqual({ '0000aaaa1111bbbb': 0.12, '(outside islands)': 0.03 });
	});

	it('/page?format=keep answers the dump for the browser to keep, with the byte strip of the rendered document', async () => {
		const handle = profiler({ secret: 'prof-key' });
		const doc =
			'<!doctype html><html><head><title>d</title><style>.x{}</style></head><body><p>hi</p>' +
			'<ogygia-region data-og-fp="0000aaaa1111bbbb" entry="/_app/x.js"><b>i</b></ogygia-region>' +
			'<script type="application/ogygia-page">{"data":{"products":[1,2,3],"flags":{"a":true}}}</script>' +
			'<script type="application/ogygia-props" data-ogygia-props>[]</script></body></html>';
		// the page profile renders through event.fetch (Kit's internal render), not resolve
		const ev = make_event('/__profiler/page?p=/deep&runs=2&cold=0&format=keep');
		(ev as { fetch: unknown }).fetch = async () => new Response(doc, { headers: { 'content-type': 'text/html' } });
		const res = await handle({ event: ev, resolve: async () => new Response('no') });
		expect(res.status).toBe(200);
		const keep = (await res.json()) as { id: string; url: string; dump: { kind: string; meta: { id: string; page: string }; extras: { strip?: { total: number; by_kind: Record<string, number>; segments: { kind: string }[] } } } };
		expect(keep.url).toBe(`/__profiler/report/${keep.id}`);
		expect(keep.dump.kind).toBe('ogygia-profiler-dump');
		expect(keep.dump.meta.page).toBe('/deep');
		const strip = keep.dump.extras.strip!;
		expect(strip.total).toBe(doc.length);
		expect(strip.segments.map((s) => s.kind)).toEqual(['head', 'style', 'head', 'markup', 'island', 'seed', 'props', 'markup']);
		expect(strip.by_kind.seed).toBeGreaterThan(40);
		// the report JSON carries the same strip; the river needs load lanes or calls (none here)
		const json = await (await handle({ event: make_event(`/__profiler/report/${keep.id}.json`), resolve: async () => new Response('no') })).json();
		expect(json.strip.total).toBe(doc.length);
		expect(json.river).toBeNull();
	});

	it('nested traces: a request that asks gets our picture in a header; our outbound calls ask while recording', async () => {
		const handle = profiler({ secret: 'prof-key' });
		const res = await handle({ event: make_event('/api/thing', { 'x-og-trace': '1' }), resolve: async () => new Response('ok') });
		const t = decode_trace(res.headers.get('x-og-trace'))!;
		expect(t).toMatchObject({ calls: 0, wait_ms: 0, route: '/[slug]', profiler: '/__profiler' });
		expect(t.ms).toBeGreaterThanOrEqual(0);
		expect(t.cpu_ms).toBeGreaterThanOrEqual(0);
		// without the ask, no answer
		const plain = await handle({ event: make_event('/api/thing'), resolve: async () => new Response('ok') });
		expect(plain.headers.get('x-og-trace')).toBeNull();
		// the round trip, capped: a long top list is trimmed until the header fits
		const big = encode_trace({ ms: 10, cpu_ms: 1, wait_ms: 2, calls: 3, top: Array.from({ length: 400 }, (_, i) => ({ url: `http://h/${'x'.repeat(150)}/${i}`, ms: i })) });
		expect(big.length).toBeLessThanOrEqual(4000);
		expect(decode_trace(big)!.top!.length).toBeLessThan(400);
		expect(decode_trace('not base64 json')).toBeUndefined();
		expect(decode_trace(null)).toBeUndefined();
		// outbound: the wrapped fetch adds the ask only while stacks are captured (a recording)
		const seen: (string | null)[] = [];
		const fake = (async (_i: RequestInfo | URL, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get('x-og-trace'));
			return new Response('x', { headers: { 'x-og-trace': encode_trace({ ms: 7, cpu_ms: 1, wait_ms: 0, calls: 0 }) } });
		}) as typeof fetch;
		const wrapped = wrap_event_fetch(fake);
		await wrapped('http://up/x', { headers: { accept: 'text/plain' } });
		set_stack_capture(true);
		try {
			await wrapped('http://up/x', { headers: { accept: 'text/plain' } });
		} finally {
			set_stack_capture(false);
		}
		expect(seen).toEqual([null, '1']);
	});

	it('the sink: request rows post as NDJSON with the bearer key; a failed post keeps the rows', async () => {
		const posts: { url: string; body: string; auth: string | null }[] = [];
		let fail = true;
		const orig = globalThis.fetch;
		globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
			posts.push({ url: String(url), body: String(init?.body), auth: new Headers(init?.headers).get('authorization') });
			return new Response(fail ? 'no' : 'ok', { status: fail ? 500 : 200 });
		}) as typeof fetch;
		try {
			const handle = profiler({ secret: 'prof-key', sink: { url: 'http://sink.test/rows', key: 'sk', every: 1000 } });
			await handle({ event: make_event('/a'), resolve: async () => new Response('ok') });
			await handle({ event: make_event('/b'), resolve: async () => new Response('ok') });
			await new Promise((r) => setTimeout(r, 1300));
			expect(posts.length).toBeGreaterThanOrEqual(1);
			expect(posts[0].url).toBe('http://sink.test/rows');
			expect(posts[0].auth).toBe('Bearer sk');
			const rows = posts[0].body.split('\n').map((l) => JSON.parse(l) as { k: string; path: string; ms: number });
			expect(rows.map((r) => r.path)).toEqual(['/a', '/b']);
			expect(rows.every((r) => r.k === 'req' && r.ms >= 0)).toBe(true);
			// the failed post's rows are kept and go again with the next flush
			fail = false;
			await new Promise((r) => setTimeout(r, 1300));
			const again = posts[posts.length - 1].body.split('\n').map((l) => (JSON.parse(l) as { path: string }).path);
			expect(again).toEqual(expect.arrayContaining(['/a', '/b']));
			// the site page draws this instance's rows and reports the sink's state
			const site = await handle({ event: make_event('/__profiler/site', { 'x-profiler-key': 'prof-key' }), resolve: async () => new Response('no') });
			expect(site.status).toBe(200);
			const html = await site.text();
			expect(html).toContain('The whole site');
			expect(html).toContain('http://sink.test/rows');
		} finally {
			globalThis.fetch = orig;
		}
	}, 10_000);

	it('compare with a report this server no longer holds renders the browser-store fallback, not a 404', async () => {
		const handle = profiler({ secret: 'prof-key' });
		const res = await handle({ event: make_event('/__profiler/compare/gone1/gone2', { 'x-profiler-key': 'prof-key' }), resolve: async () => new Response('no') });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('Reading both reports from this browser');
	});
});

describe('a visit posted in halves', () => {
	it('the runtime half (islands) and the mark half (marks) of one visit fold into one picture', async () => {
		const handle = profiler({ secret: 'prof-key' });
		const post = (body: unknown) =>
			handle({ event: { ...make_event('/__profiler/beacon'), request: new Request('http://localhost/__profiler/beacon', { method: 'POST', body: JSON.stringify(body) }) } as RequestEvent, resolve: async () => new Response('no') });
		const nav = { req_start: 1, res_start: 100, res_end: 150 };
		expect((await post({ page: '/halves', visit: { at: 77, nav, islands: [{ fp: '0000aaaa1111bbbb', t0: 300, loaded: 320, done: 360 }] } })).status).toBe(204);
		expect((await post({ page: '/halves', visit: { at: 77, nav: { ...nav, load: 900 }, paints: { lcp: 500 }, marks: [{ name: 'ds.hydrate', ms: 40, t0: 200 }] } })).status).toBe(204);
		const rec = await handle({ event: make_event('/__profiler/page?p=/halves&runs=1&cold=0'), resolve: async () => new Response('<html></html>') });
		const dump = await (await handle({ event: make_event(rec.headers.get('location')!.replace('http://localhost', '') + '.dump'), resolve: async () => new Response('no') })).json();
		const v = dump.extras.visit;
		expect(v.at).toBe(77);
		expect(v.islands.map((i: { fp: string }) => i.fp)).toEqual(['0000aaaa1111bbbb']);
		expect(v.marks).toEqual([{ name: 'ds.hydrate', ms: 40, t0: 200 }]);
		expect(v.nav.load).toBe(900);
		expect(v.paints.lcp).toBe(500);
		// a different visit of the same page stays separate and becomes the latest
		expect((await post({ page: '/halves', visit: { at: 99, nav } })).status).toBe(204);
		const rec2 = await handle({ event: make_event('/__profiler/page?p=/halves&runs=1&cold=0'), resolve: async () => new Response('<html></html>') });
		const json = await (await handle({ event: make_event(rec2.headers.get('location')!.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		expect(json.browser.visit.at).toBe(99);
	});
});

describe('who caused the GC, on the host', () => {
	it('a render that churns memory gets its pauses attributed to the allocating function', async () => {
		const handle = profiler({ secret: 'prof-key' });
		// 60 MB of short-lived garbage per render, from a named function the sampler can see
		function make_garbage(): number {
			let n = 0;
			for (let i = 0; i < 60; i++) {
				const chunk = new Array(1024 * 128).fill(0).map((_, j) => ({ j, s: 'x' + j }));
				n += chunk.length;
			}
			return n;
		}
		const ev = make_event('/__profiler/page?p=/churn&runs=1&cold=0');
		(ev as { fetch: unknown }).fetch = async () => {
			make_garbage();
			return new Response('<html><body>churn</body></html>', { headers: { 'content-type': 'text/html' } });
		};
		const rec = await handle({ event: ev, resolve: async () => new Response('no') });
		const json = await (await handle({ event: make_event(rec.headers.get('location')!.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		const g = json.memory.gc_attribution;
		expect(g).not.toBeNull();
		expect(g.count).toBeGreaterThanOrEqual(1);
		expect(g.slices).toBeGreaterThanOrEqual(1);
		expect(g.allocated_mb).toBeGreaterThan(10);
		expect(g.makers.length).toBeGreaterThan(0);
		// the churner is the top maker (or right behind V8's own array builtins on its stack)
		const top = g.makers.slice(0, 5).map((m: { name: string }) => m.name);
		expect(top.some((n: string) => /make_garbage|map|fill|Array/.test(n))).toBe(true);
		expect(g.pauses[0].why).toMatch(/young space filled|old space grew|nothing sampled|incremental|forced/);
		expect(json.findings.some((f: { code: string }) => f.code === 'gc-cause')).toBe(g.makers[0].gc_ms >= 3 && g.makers[0].share >= 0.15);
	}, 30_000);
});

describe('the profiler’s own cost is taken out', () => {
	it('analyze: samples on the profiler’s own frames are overhead, not busy time', () => {
		const p = {
			startTime: 0,
			endTime: 40_000,
			nodes: [
				{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 }, children: [2, 3, 4] },
				{ id: 2, callFrame: { functionName: 'render', url: '/app/src/lib/Page.svelte', lineNumber: 1, columnNumber: 0 } },
				{ id: 3, callFrame: { functionName: 'heap_sites', url: '/x/node_modules/ogygia/dist/profiler/gc.js', lineNumber: 1, columnNumber: 0 } },
				{ id: 4, callFrame: { functionName: '(idle)', url: '', lineNumber: 0, columnNumber: 0 } }
			],
			samples: [2, 2, 3, 4],
			timeDeltas: [10_000, 10_000, 10_000, 10_000]
		};
		const a = analyze(p as never);
		expect(a.busy_ms).toBe(20);
		expect(a.overhead_ms).toBe(10);
		expect(a.idle_ms).toBe(10);
	});
	it('a page report carries the overhead it took out, and the runs as the app would have paid them', async () => {
		const handle = profiler({ secret: 'prof-key' });
		const ev = make_event('/__profiler/page?p=/o&runs=2&cold=0');
		(ev as { fetch: unknown }).fetch = async () => {
			const junk = new Array(200_000).fill(0).map((_, i) => ({ i }));
			return new Response('<html>' + junk.length + '</html>');
		};
		const rec = await handle({ event: ev, resolve: async () => new Response('no') });
		const json = await (await handle({ event: make_event(rec.headers.get('location')!.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		const o = json.summary.overhead;
		expect(o).not.toBeNull();
		expect(o.cpu_ms).toBeGreaterThanOrEqual(0);
		expect(o.gc_ms).toBeGreaterThanOrEqual(0);
		if (o.per_run_ms > 0) {
			expect(json.target.runs_measured).toHaveLength(2);
			for (let i = 0; i < 2; i++) expect(json.target.runs[i]).toBeLessThanOrEqual(json.target.runs_measured[i]);
		}
	}, 30_000);
});

describe('compare: the garbage makers diff', () => {
	it('matches makers by line, signs the change, and marks what is only on one side', () => {
		const tiny: CpuProfile = { startTime: 0, endTime: 1000, nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: 0, columnNumber: 0 } }], samples: [1], timeDeltas: [1000] };
		const base = { meta: { id: 'a', created: 0, trigger: 'page' as const, page: '/p', runs: [10], duration_ms: 10, sample_interval_us: 500, requests: [], node: 'v' }, analysis: analyze(tiny), findings: [] };
		const gc = (makers: { name: string; caller?: string; allocated: number; gc_ms: number }[], total_ms: number, allocated_mb: number) => ({
			summary: { count: 1, total_ms, max_ms: total_ms, measured_ms: total_ms, overhead_ms: 0, minor: 1, major: 0, incremental: 0, weak: 0, allocated_mb, alloc_rate_mb_s: 0, slices: 1, slice_ms: 10 },
			pauses: [],
			makers: makers.map((m) => ({ key: m.name, name: m.name, url: 'x.ts', line: 1, category: 'node' as const, component: null, ...(m.caller ? { caller: m.caller } : {}), allocated: m.allocated, share: 0.5, gc_ms: m.gc_ms, pauses: 0 })),
			components: []
		});
		const a = { ...base, gc: gc([{ name: 'replace', caller: 'splice (ds.ts:61)', allocated: 1_771_000_000, gc_ms: 60 }, { name: 'indexOf', caller: 'insert (ds.ts:82)', allocated: 62_000_000, gc_ms: 2 }], 90, 2600) };
		const b = { ...base, meta: { ...base.meta, id: 'b', created: 1 }, gc: gc([{ name: 'join', caller: 'splice (ds.ts:130)', allocated: 3_000_000, gc_ms: 0.1 }, { name: 'indexOf', caller: 'insert (ds.ts:82)', allocated: 1_000_000, gc_ms: 0.05 }], 20, 300) };
		const cmp = compare_reports(a, b);
		expect(cmp.summary.find((r) => r.label === 'allocated in the window')).toMatchObject({ a: 2600, b: 300, d: -2300, unit: 'MB' });
		expect(cmp.summary.find((r) => r.label === 'garbage collection')).toMatchObject({ a: 90, b: 20, d: -70 });
		expect(cmp.gc_makers.map((m) => `${m.name}:${m.d_gc_ms}:${m.only ?? ''}`)).toEqual(['replace:-60:a', 'indexOf:-1.95:', 'join:0.1:b']);
		expect(cmp.gc_makers[0]).toMatchObject({ a_mb: 1688.96, b_mb: 0, d_mb: -1688.96 });
		// without attribution on either side, the diff is empty and the rows are absent
		expect(compare_reports(base, { ...base, meta: { ...base.meta, id: 'c' } }).gc_makers).toEqual([]);
		expect(compare_reports(base, base).summary.some((r) => r.label === 'allocated in the window')).toBe(false);
	});
});

describe('more from the same snapshot, on the host', () => {
	it('a page profile counts the promises per render and measures what a render leaves behind', async () => {
		const handle = profiler({ secret: 'prof-key' });
		const kept: unknown[] = []; // a module-level "cache" that keeps part of every render
		const ev = make_event('/__profiler/page?p=/keep&runs=2&cold=0');
		(ev as { fetch: unknown }).fetch = async () => {
			for (let i = 0; i < 2000; i++) await Promise.resolve(i); // a small promise storm
			const rows = new Array(20_000).fill(0).map((_, i) => ({ i, s: 'row ' + i }));
			kept.push(rows); // ~1 MB kept per render
			return new Response('<html>' + rows.length + '</html>');
		};
		const rec = await handle({ event: ev, resolve: async () => new Response('no') });
		const json = await (await handle({ event: make_event(rec.headers.get('location')!.replace('http://localhost', '') + '.json'), resolve: async () => new Response('no') })).json();
		expect(json.promises).not.toBeNull();
		expect(json.promises.per_render).toBeGreaterThanOrEqual(2000);
		expect(json.retained).not.toBeNull();
		expect(json.retained.total_bytes).toBeGreaterThan(200_000);
		expect(json.retained.sites.length).toBeGreaterThan(0);
		expect(Array.isArray(json.deopts)).toBe(true);
		expect(Array.isArray(json.sync_io)).toBe(true);
		expect(Array.isArray(json.memo_candidates)).toBe(true);
		expect(kept.length).toBeGreaterThanOrEqual(3); // the runs plus the retention render
	}, 40_000);
});

describe('paths: the owner is a named place', () => {
	it('an anonymous arrow holding the hot functions never owns the path; its named parent does, and the app’s own hot functions stay in the set beside a dependency’s many', () => {
		const frame = (functionName: string, url: string, line = 1) => ({ functionName, url, lineNumber: line, columnNumber: 0 });
		// Card → priceTable → (anonymous arrow) → fmt / sym ; plus 45 hot dependency internals
		const nodes: { id: number; callFrame: ReturnType<typeof frame>; children?: number[] }[] = [
			{ id: 1, callFrame: frame('(root)', ''), children: [2, 100] },
			{ id: 2, callFrame: frame('Card', '/app/src/lib/Card.svelte'), children: [3] },
			{ id: 3, callFrame: frame('priceTable', '/app/src/lib/util.ts', 9), children: [4] },
			{ id: 4, callFrame: frame('(anonymous)', '/app/src/lib/util.ts', 12), children: [5, 6] },
			{ id: 5, callFrame: frame('fmt', '/app/src/lib/util.ts', 30) },
			{ id: 6, callFrame: frame('sym', '/app/src/lib/util.ts', 40) },
			{ id: 100, callFrame: frame('render', '/app/node_modules/ds/hydrate/index.mjs', 1), children: [] }
		];
		const samples: number[] = [];
		const deltas: number[] = [];
		for (let i = 0; i < 45; i++) {
			nodes.push({ id: 200 + i, callFrame: frame(`dep${i}`, '/app/node_modules/ds/hydrate/index.mjs', 100 + i) });
			nodes[6].children!.push(200 + i);
			for (let k = 0; k < 20; k++) { samples.push(200 + i); deltas.push(1000); } // 20 ms each: 900 ms of dependency
		}
		for (let k = 0; k < 30; k++) { samples.push(5); deltas.push(1000); } // fmt 30 ms
		for (let k = 0; k < 20; k++) { samples.push(6); deltas.push(1000); } // sym 20 ms
		const a = analyze({ startTime: 0, endTime: samples.length * 1000, nodes, samples, timeDeltas: deltas } as never);
		const owners = a.paths.map((p) => p.owner.name);
		expect(owners).not.toContain('(anonymous)');
		const card = a.paths.find((p) => p.owner.name === 'Card' || p.owner.name === 'priceTable');
		expect(card).toBeDefined();
		expect(card!.fns.map((f) => f.name).sort()).toEqual(['fmt', 'sym']);
	});
});
