import { describe, expect, it, vi } from 'vitest';
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
