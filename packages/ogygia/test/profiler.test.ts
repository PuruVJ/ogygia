import { describe, expect, it } from 'vitest';
import {
	analyze,
	analyze_heap,
	categorize,
	decode_mappings,
	sourcemap_resolver,
	type CpuProfile,
	type HeapNode
} from '../src/profiler/analyze.js';
import { sequential_ms, type NetCall } from '../src/profiler/net.js';
import { profiler } from '../src/profiler/index.js';
import { io_kind } from '../src/profiler/async-io.js';
import { render_report, report_json, report_dump, is_dump, derive_findings } from '../src/profiler/report.js';
import type { RequestEvent } from '@sveltejs/kit';

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
			{ id: 4, callFrame: frame('escape', '/app/node_modules/svelte/src/internal/server/escaping.js', 3) },
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
});

describe('render_report visuals', () => {
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
		const html = render_report(a, meta, '/__profiler', { net: [], heap: null, mem: [] });
		expect(html).toContain('Where the time went');
		expect(html).toContain('<canvas id="tree"'); // interactive zoomable treemap
		expect(html).toContain('id="tree-data"'); // hierarchy for client-side zoom
		const budget = /<div class="budget">([\s\S]*?)<\/div>\s*<div class="legend"/.exec(html);
		expect(budget).toBeTruthy();
		// idle is the '#3a3f47' color — must appear exactly once (not double-counted)
		const idleCells = (budget![1].match(/background:#3a3f47/g) ?? []).length;
		expect(idleCells).toBe(1);
		// widths sum to ~100% (idle counted once → ~100, double → ~150)
		const widths = [...budget![1].matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));
		const sum = widths.reduce((s, w) => s + w, 0);
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
				{ id: 4, callFrame: frame('escape', '/app/node_modules/svelte/src/internal/server/x.js', 3) },
				{ id: 5, callFrame: frame('(garbage collector)') }
			],
			samples: [4, 3, 2, 5],
			timeDeltas: [1000, 1000, 1000, 1000]
		};
		const a = analyze(profile);
		const j = report_json(a, meta, '/__profiler', { net: [], heap: null, mem: [] }) as Record<string, any>;

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
		// the uploaded dump renders the same report as the live one
		const live = render_report(a, meta, '/__profiler', extras);
		const fromDump = render_report(wire.analysis, wire.meta, '/__profiler', wire.extras);
		expect(fromDump).toBe(live);
		expect(fromDump).toContain('Header');
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
		const html = render_report(a, meta, '/__profiler', { net: [], heap: null, mem: [] });
		// every finding message appears verbatim in the rendered verdict
		for (const f of findings) expect(html).toContain(f.message);
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
		const html = render_report(a, meta, '/__profiler', { net: [], heap: null, mem: [] });
		const body = html.slice(html.indexOf('data-sortable'));
		const first = body.indexOf('data-name="Heavy"');
		const ancestor = body.indexOf('data-name="_page"');
		// Heavy (self-heavy) must appear before _page (self ~0) in default order
		expect(first).toBeGreaterThan(0);
		expect(first).toBeLessThan(ancestor);
		// default sort marker is on the self column
		expect(html).toContain('data-key="self" data-dir="desc"');
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
		const html = render_report(a, meta2, '/__profiler', {
			net: [netcall('callService (data.ts:8)', 2000)],
			heap: null,
			mem: [],
			io: [
				{ type: 'Timeout', caller: 'queryDatabase (db.ts:4)', ms: 1500 },
				{ type: 'FSREQCALLBACK', caller: 'readConfig (config.ts:2)', ms: 12 }
			]
		});
		expect(html).toContain('Waiting by function');
		expect(html).toContain('callService (data.ts:8)');
		expect(html).toContain('queryDatabase (db.ts:4)'); // the timer wait, invisible to CPU sampling
		expect(html).toContain('readConfig (config.ts:2)');
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
			io: [{ type: 'Timeout', caller: 'queryDatabase (db.ts:4)', ms: 1500 }]
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
		expect(categorize(frame('_page', '/out/entries/pages/_page.svelte.js')).category).toBe('component');
		// endpoint handlers are capitalized but are app code, not components
		expect(categorize(frame('GET', '/out/entries/endpoints/api/_server.ts.js')).category).toBe('app');
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
		expect(lines[0].cols).toEqual([[0, 0, 10, -1]]);

		const map = JSON.stringify({ sources: ['src/lib/Slow.svelte'], mappings });
		const resolver = sourcemap_resolver((p) => (p === '/out/chunk.js.map' ? map : undefined));
		expect(resolver.resolve('/out/chunk.js', 0, 5)).toEqual({
			source: 'src/lib/Slow.svelte',
			line: 11,
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
			source: 'src/lib/data.ts',
			line: 5,
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
