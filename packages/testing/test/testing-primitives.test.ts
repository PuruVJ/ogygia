import { describe, it, expect } from 'vitest';
import {
	checkBudget,
	ogygiaMatchers,
	compare,
	toMarkdown,
	createOgygia,
	type OgygiaReport
} from '../src/index.ts';

const page = {
	kind: 'page',
	url: '/x',
	nav: null,
	vitals: [
		{ key: 'lcp', label: 'LCP', value: 1800, rating: 'good' },
		{ key: 'cls', label: 'CLS', value: 0.2, rating: 'fair' }
	],
	islands: [
		{
			fp: 'a',
			name: 'A',
			wake: 'load',
			load_ms: 10,
			queue_ms: 0,
			hydrate_ms: 5,
			t0: 10,
			done: 90,
			recovered: false,
			changed: false,
			shift: 0,
			longtask_ms: 0,
			early_ms: null,
			below_fold: false,
			cpu_ms: null
		}
	],
	findings: [
		{ code: 'long-hydrate', severity: 'warn', message: 'A took 80 ms', fps: ['a'], names: ['A'] }
	],
	blocking: [],
	bytes: [],
	longtask_ms: 120,
	cpu: null
} as unknown as OgygiaReport;

const profile = (
	score: number,
	runs: number[],
	findings: { code: string; severity: string; message: string }[] = []
) =>
	({
		kind: 'profile',
		id: 'x',
		target: { page: '/x', runs },
		score: { score, grade: 'B', categories: [], missing: [] },
		forecast: null,
		findings,
		assets: { totals: { js: 200_000, wire: 90_000, lazy_js: 0 } },
		links: { html: '', json: '' }
	}) as unknown as OgygiaReport;

describe('checkBudget', () => {
	it('reads each report kind', () => {
		expect(checkBudget(page, { lcp: 2500, cls: 0.1, islandWakeMs: 100 })).toEqual([
			{ key: 'lcp', measured: 1800, limit: 2500, ok: true },
			{ key: 'cls', measured: 0.2, limit: 0.1, ok: false },
			{ key: 'islandWakeMs', measured: 80, limit: 100, ok: true }
		]);
		const p = profile(82, [100, 140, 120]);
		expect(
			checkBudget(p, { score: 80, renderMs: 110, jsBytes: 250_000 }).map((l) => [l.key, l.ok])
		).toEqual([
			['score', true],
			['renderMs', false],
			['jsBytes', true]
		]);
	});
	it('a line with nothing measured fails, and says so', () => {
		const r = ogygiaMatchers.toMeetBudget(page, { inp: 200 });
		expect(r.pass).toBe(false);
		expect(r.message()).toContain('inp: not measured');
	});
});

describe('matchers', () => {
	it('toHaveNoFindings by severity and ignore', () => {
		expect(ogygiaMatchers.toHaveNoFindings(page).pass).toBe(false);
		expect(ogygiaMatchers.toHaveNoFindings(page, { severity: 'error' }).pass).toBe(true);
		expect(ogygiaMatchers.toHaveNoFindings(page, { ignore: ['long-hydrate'] }).pass).toBe(true);
		expect(ogygiaMatchers.toHaveNoFindings(page).message()).toContain(
			'[warn] long-hydrate: A took 80 ms'
		);
	});
	it('toHydrateCleanly names the island and the first difference', () => {
		const hyd = {
			kind: 'hydration',
			measured: true,
			islands: [
				{
					fp: 'c',
					name: 'Clock',
					wake: 'load',
					status: 'changed',
					reason: '',
					diff: {
						hunks: [
							{
								ops: [
									{ op: 'del', text: 'server' },
									{ op: 'add', text: 'browser' }
								]
							}
						],
						removed: 1,
						added: 1,
						partial: false
					}
				},
				{ fp: 'h', name: 'Healthy', wake: 'load', status: 'clean', reason: '', diff: null }
			]
		} as unknown as OgygiaReport;
		const r = ogygiaMatchers.toHydrateCleanly(hyd);
		expect(r.pass).toBe(false);
		expect(r.message()).toContain('Clock: changed — −server +browser');
		expect(ogygiaMatchers.toHydrateCleanly(hyd, { allow: ['changed'] }).pass).toBe(true);
	});
	it('toHydrateCleanly can let attribute-only changes, or changes under input, through', () => {
		const hyd = (attributesOnly: boolean, inputDuringHydration: boolean) =>
			({
				kind: 'hydration',
				measured: true,
				islands: [
					{
						fp: 'a',
						name: 'SearchBar',
						wake: 'idle',
						status: 'changed',
						reason: '',
						diff: null,
						attributesOnly,
						inputDuringHydration
					}
				]
			}) as unknown as OgygiaReport;
		expect(ogygiaMatchers.toHydrateCleanly(hyd(true, false)).pass).toBe(false);
		expect(
			ogygiaMatchers.toHydrateCleanly(hyd(true, false), { allowAttributeChanges: true }).pass
		).toBe(true);
		expect(
			ogygiaMatchers.toHydrateCleanly(hyd(false, false), { allowAttributeChanges: true }).pass
		).toBe(false);
		expect(ogygiaMatchers.toHydrateCleanly(hyd(false, true), { allowInput: true }).pass).toBe(true);
	});
});

describe('compare / toMarkdown', () => {
	it('what moved between two runs of the same test', () => {
		const base = [
			{
				test: 't',
				reports: [profile(80, [100], [{ code: 'old', severity: 'warn', message: 'old one' }])]
			}
		];
		const head = [
			{
				test: 't',
				reports: [profile(86, [80], [{ code: 'new', severity: 'warn', message: 'new one' }])]
			}
		];
		const d = compare(base, head);
		expect(d[0]).toMatchObject({
			score: { base: 80, head: 86 },
			renderMs: { base: 100, head: 80 }
		});
		expect(d[0].findings.added).toEqual(['new: new one']);
		expect(d[0].findings.fixed).toEqual(['old: old one']);
		const md = toMarkdown(d);
		expect(md).toContain('score 80 → 86');
		expect(md).toContain('server render 100 → 80 ms');
		expect(toMarkdown(compare(base, base))).toContain('no change');
	});

	it('the files behind a JS move, known by what they hold (hashed names change every build)', () => {
		const withFiles = (
			files: { url: string; bytes: number; contains?: string[]; lazy?: boolean }[]
		) => {
			const r = profile(80, [100]) as unknown as {
				assets: { totals: { js: number; wire: number; lazy_js: number }; files: unknown[] };
			};
			const js = files.filter((f) => !f.lazy).reduce((s, f) => s + f.bytes, 0);
			r.assets = {
				totals: { js, wire: 0, lazy_js: 0 },
				files: files.map((f) => ({ kind: 'script', ...f }))
			};
			return r as unknown as OgygiaReport;
		};
		const base = [
			{
				test: 't',
				reports: [
					withFiles([
						{ url: '/_app/a-HASH1.js', bytes: 40_000, contains: ['svelte runtime'] },
						{ url: '/_app/b-HASH1.js', bytes: 30_000, contains: ['src/lib/Old.svelte'] }
					])
				]
			}
		];
		const head = [
			{
				test: 't',
				reports: [
					withFiles([
						// same file, new hash, grew
						{ url: '/_app/a-HASH2.js', bytes: 52_000, contains: ['svelte runtime'] },
						{
							url: '/_app/c-HASH2.js',
							bytes: 120_000,
							contains: ['src/lib/Editor.svelte', '@codemirror/state']
						}
					])
				]
			}
		];
		const d = compare(base, head)[0];
		expect(d.js?.changes).toEqual([
			'new src/lib/Editor.svelte, @codemirror/state 117 KB',
			'grew svelte runtime 39 KB → 51 KB',
			'gone src/lib/Old.svelte 29 KB'
		]);
		expect(toMarkdown([d])).toContain(
			'JS at start 68 → 168 KB: new src/lib/Editor.svelte, @codemirror/state 117 KB; grew svelte runtime'
		);
		// the same file, same size, now loading at start: an island's wake changed
		const later = [
			{
				test: 't',
				reports: [
					withFiles([
						{
							url: '/_app/e-H1.js',
							bytes: 400_000,
							contains: ['src/lib/Editor.svelte'],
							lazy: true
						}
					])
				]
			}
		];
		const eager = [
			{
				test: 't',
				reports: [
					withFiles([{ url: '/_app/e-H2.js', bytes: 400_000, contains: ['src/lib/Editor.svelte'] }])
				]
			}
		];
		expect(compare(later, eager)[0].js?.changes).toEqual([
			'now at start src/lib/Editor.svelte 391 KB (loaded later before)'
		]);
		expect(compare(eager, later)[0].js?.changes).toEqual([
			'now loads later src/lib/Editor.svelte 391 KB'
		]);
	});
});

describe('compare: hydration, session counts, vitals', () => {
	const hyd = (islands: { key?: string; name: string; status: string }[]) =>
		({
			kind: 'hydration',
			measured: true,
			islands: islands.map((i, n) => ({ fp: 'f' + n, wake: 'load', reason: '', diff: null, ...i }))
		}) as unknown as OgygiaReport;
	const sess = (counts: Record<string, number>) =>
		({
			kind: 'session',
			counts,
			findings: [],
			navigations: [],
			interactions: [],
			requests: []
		}) as unknown as OgygiaReport;
	const pg = (lcp: number, cls: number) =>
		({
			...(page as object),
			vitals: [
				{ key: 'lcp', value: lcp },
				{ key: 'cls', value: cls }
			],
			findings: []
		}) as unknown as OgygiaReport;

	it('names the island instance that broke and the one that was fixed', () => {
		const base = [
			{
				test: 't',
				reports: [
					hyd([
						{ key: 'Carousel#1', name: 'Carousel', status: 'clean' },
						{ key: 'Carousel#2', name: 'Carousel', status: 'failed' }
					])
				]
			}
		];
		const head = [
			{
				test: 't',
				reports: [
					hyd([
						{ key: 'Carousel#1', name: 'Carousel', status: 'failed' },
						{ key: 'Carousel#2', name: 'Carousel', status: 'clean' }
					])
				]
			}
		];
		expect(compare(base, head)[0].hydration).toEqual({
			broke: ['Carousel#1: clean → failed'],
			fixed: ['Carousel#2: failed → clean']
		});
	});
	it('reports without keys compare as a tally per name and status', () => {
		const base = [
			{
				test: 't',
				reports: [
					hyd([
						{ name: 'Carousel', status: 'failed' },
						{ name: 'Carousel', status: 'clean' }
					])
				]
			}
		];
		const head = [
			{
				test: 't',
				reports: [
					hyd([
						{ name: 'Carousel', status: 'failed' },
						{ name: 'Carousel', status: 'failed' }
					])
				]
			}
		];
		expect(compare(base, head)[0].hydration).toEqual({ broke: ['Carousel: failed ×1'], fixed: [] });
	});
	it('session counts and vitals past the noise, in the markdown', () => {
		const base = [
			{ test: 't', reports: [pg(1800, 0.05), sess({ errors: 0, shifts: 1, slow: 0, cls: 0.03 })] }
		];
		const head = [
			{ test: 't', reports: [pg(2400, 0.06), sess({ errors: 2, shifts: 1, slow: 0, cls: 0.2 })] }
		];
		const d = compare(base, head);
		expect(d[0].vitals).toEqual([{ key: 'lcp', base: 1800, head: 2400 }]); // CLS moved 0.01: noise
		expect(d[1].session).toEqual([
			{ key: 'errors', base: 0, head: 2 },
			{ key: 'cls', base: 0.03, head: 0.2 }
		]);
		const md = toMarkdown(d);
		expect(md).toContain('LCP 1800 ms → 2400 ms');
		expect(md).toContain('errors 0 → 2');
		expect(md).toContain('session CLS 0.03 → 0.2');
		expect(compare(base, head, { noise: { lcp: 1000 } })[0].vitals).toBeUndefined();
	});
	it('several runs a side: load signals by median and majority, session signals only when every head run has them and no base run does', () => {
		const s = (errors: number, codes: string[], navigations = 0) =>
			({
				kind: 'session',
				counts: { errors, shifts: 0, slow: 0, cls: 0 },
				findings: codes.map((code) => ({ code, severity: 'warn', message: code })),
				navigations: Array.from({ length: navigations }, () => ({ url: '/' })),
				interactions: [],
				requests: []
			}) as unknown as OgygiaReport;
		const p = (lcp: number, codes: string[]) =>
			({
				...(pg(lcp, 0) as object),
				findings: codes.map((code) => ({ code, severity: 'warn', message: code }))
			}) as unknown as OgygiaReport;
		const base = [
			{
				test: 't',
				runs: [
					[p(1800, []), s(0, [])],
					[p(1900, ['late-image']), s(1, ['errors'])],
					[p(1850, []), s(0, [])]
				]
			}
		];
		const head = [
			{
				test: 't',
				runs: [
					[p(2500, ['long-hydrate']), s(2, ['errors', 'rage-click', 'navigation-blocked'], 1)],
					[p(2600, ['long-hydrate']), s(3, ['rage-click', 'navigation-blocked'], 1)],
					[p(1800, []), s(2, ['rage-click', 'navigation-blocked'], 1)]
				]
			}
		];
		const [load, session] = compare(base, head);
		// a page finding in most head runs and few base runs; LCP by median (2500 vs 1850)
		expect(load.findings.added).toEqual(['long-hydrate: long-hydrate']);
		expect(load.vitals).toEqual([{ key: 'lcp', base: 1850, head: 2500 }]);
		// `errors` appeared in one base run: not a regression; `rage-click` in every head run and no base one
		expect(session.findings.added).toEqual(['rage-click: rage-click']);
		// counts move when every head run is above every base run (errors 2–3 vs 0–1), as medians; the
		// navigation finding is left to its own count
		expect(session.session).toEqual([
			{ key: 'errors', base: 0, head: 2 },
			{ key: 'navigations', base: 0, head: 1 }
		]);
		// overlapping runs are noise
		const base2 = [{ test: 't', runs: [[s(0, [])], [s(3, [])]] }];
		const head2 = [{ test: 't', runs: [[s(2, [])], [s(3, [])]] }];
		expect(compare(base2, head2)[0].session).toBeUndefined();
	});
	it('several runs of hydration: each instance by its most common status', () => {
		const run = (status: string) => [hyd([{ key: 'Carousel#1', name: 'Carousel', status }])];
		const base = [{ test: 't', runs: [run('clean'), run('clean'), run('failed')] }];
		const head = [{ test: 't', runs: [run('failed'), run('failed'), run('clean')] }];
		expect(compare(base, head)[0].hydration).toEqual({
			broke: ['Carousel#1: clean → failed'],
			fixed: []
		});
	});
	it('a session meets a CLS budget', () => {
		expect(checkBudget(sess({ cls: 0.2 }), { cls: 0.1 })).toEqual([
			{ key: 'cls', measured: 0.2, limit: 0.1, ok: false }
		]);
	});
});

describe('createOgygia', () => {
	it('drives any page driver, and tells you when the page has no testing API', async () => {
		const o = createOgygia({ evaluate: async () => false as never }, { timeout: 50 });
		await expect(o.page()).rejects.toThrow('plugins: [ogygia(), devtools(), sveltekit()]');
	});
	/** A page driver over a fake in-page API: `present()` says whether the API is in the page now. */
	const fake = (
		api: Record<string, (...a: unknown[]) => unknown>,
		present: () => boolean = () => true,
		version = 3
	) => ({
		evaluate: async (fn: unknown, arg: unknown) => {
			if (arg === null)
				return (String(fn).includes('location') ? 'http://app.test/elsewhere' : present()) as never;
			const [n, a] = arg as [string, unknown[]];
			return { v: version, r: await api[n](...a) } as never;
		},
		wait: async () => {}
	});
	const session = {
		duration_ms: 1,
		counts: {},
		findings: [],
		interactions: [],
		by_island: {},
		requests: [],
		cpu: null,
		navigations: [],
		timeline: [],
		unmeasured: []
	};

	it('record(): a page that left for another document says so, with the actions’ own error as the cause', async () => {
		let here = true;
		const o = createOgygia(
			fake(
				{ settled: () => true, record_start: () => true, record_stop: () => session },
				() => here
			),
			{ timeout: 50 }
		);
		const boom = new Error('the button was gone');
		const err = await o
			.record(async () => {
				here = false; // the click reloaded the page into one with no testing API
				throw boom;
			})
			.catch((e: Error) => e);
		expect((err as Error).message).toContain('went to another document');
		expect((err as Error).message).toContain('http://app.test/elsewhere');
		expect((err as Error).message).not.toContain('plugins: [ogygia(), devtools(), sveltekit()]');
		expect((err as Error).cause).toBe(boom);
	});
	it('record(): the actions’ error still surfaces when the page stayed', async () => {
		const o = createOgygia(
			fake({ settled: () => true, record_start: () => true, record_stop: () => session })
		);
		await expect(o.record(async () => Promise.reject(new Error('plain failure')))).rejects.toThrow(
			'plain failure'
		);
	});
	it('record({ blockNavigation }): the driver holds the loads back and the page lists them', async () => {
		let stop_args: unknown[] = [];
		const held = [{ url: 'http://app.test/', t: 120 }];
		const o = createOgygia({
			...fake({
				settled: () => true,
				record_start: () => true,
				record_stop: (...a) => (
					(stop_args = a),
					{
						...session,
						navigations: [
							{ url: 'http://app.test/', t: 120, after: 'button.reload', island: 'Hero' }
						]
					}
				)
			}),
			blockNavigation: async () => ({ stop: async () => held })
		});
		const r = await o.record(async () => {}, { blockNavigation: true });
		expect(stop_args).toEqual([held]);
		expect(r.navigations[0]).toMatchObject({ after: 'button.reload', island: 'Hero' });
		await expect(
			createOgygia(fake({ settled: () => true })).record(async () => {}, { blockNavigation: true })
		).rejects.toThrow('blockNavigation()');
	});
	it('an older site’s engine: navigations filled in from what the driver held, finding names empty, warned once', async () => {
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (m: string) => warnings.push(m);
		try {
			const old_session = {
				duration_ms: 1,
				counts: { errors: 0 },
				findings: [{ code: 'errors', severity: 'warn', message: 'x', refs: [] }],
				interactions: [],
				by_island: {},
				requests: [],
				cpu: null,
				timeline: [],
				unmeasured: []
			};
			const o = createOgygia({
				...fake(
					{ settled: () => true, record_start: () => true, record_stop: () => old_session },
					() => true,
					1
				),
				blockNavigation: async () => ({ stop: async () => [{ url: 'http://app.test/', t: 50 }] })
			});
			const r = await o.record(async () => {}, { blockNavigation: true });
			expect(r.engine).toEqual({ version: 1 });
			expect(r.navigations).toEqual([
				{ url: 'http://app.test/', t: 50, after: null, island: null, approx: true }
			]);
			expect(r.findings.map((f) => [f.code, f.names])).toEqual([
				['errors', []],
				['navigation-blocked', []]
			]);
			await o.record(async () => {}, { blockNavigation: true });
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('older testing engine (version 1');
		} finally {
			console.warn = warn;
		}
	});
	it('the older-engine warning is said once per site for the whole process, not per page', async () => {
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (m: string) => warnings.push(m);
		try {
			for (let n = 0; n < 3; n++)
				await createOgygia(fake({ settled: () => true }, () => true, 2)).settled();
			expect(warnings.filter((w) => w.includes('(version 2'))).toHaveLength(1);
		} finally {
			console.warn = warn;
		}
	});
	it('ignoreAttributes crosses into the page as plain data (a RegExp as its source)', async () => {
		let asked: unknown[] = [];
		const o = createOgygia(
			fake({
				settled: () => true,
				hydration: (...a) => ((asked = a), { measured: true, islands: [] })
			}),
			{
				ignoreAttributes: [
					{ tag: /^qds-/i, name: /^(tabindex|aria-)/ },
					{ name: 'style', value: '' }
				]
			}
		);
		await o.hydration();
		expect(asked[1]).toEqual([
			{
				tag: { re: '^qds-', flags: 'i' },
				name: { re: '^(tabindex|aria-)', flags: '' },
				value: undefined
			},
			{ tag: undefined, name: 'style', value: '' }
		]);
	});
	it('record({ server }): a window that fails leaves the session whole, with server.error', async () => {
		const o = createOgygia({
			...fake({ settled: () => true, record_start: () => true, record_stop: () => session }),
			post: async (url: string) =>
				url.endsWith('/start')
					? { status: 200, body: '{"ok":true,"id":"n.s","header":"x-og-window"}' }
					: { status: 400, body: '{"error":"No window is recording"}' }
		});
		const r = await o.record(async () => {}, { server: true });
		expect(r.kind).toBe('session');
		expect(r.server).toEqual({ error: expect.stringContaining('(400)') });
	});
	it('record({ server }): the window id rides every request the session makes, and its stop', async () => {
		const tagged: string[] = [];
		let stop_headers: Record<string, string> = {};
		const o = createOgygia({
			...fake({ settled: () => true, record_start: () => true, record_stop: () => session }),
			post: async (url: string, headers: Record<string, string>) => {
				if (url.endsWith('/start'))
					return { status: 200, body: '{"ok":true,"id":"n.s","header":"x-og-window"}' };
				stop_headers = headers;
				return { status: 200, body: '{"kind":"window","window":{"ms":1,"requests":[]}}' };
			},
			tagRequests: async (h: string, v: string) => (
				tagged.push(`${h}=${v}`),
				async () => void tagged.push('untagged')
			)
		});
		await o.record(async () => {}, { server: true });
		expect(tagged).toEqual(['x-og-window=n.s', 'untagged']);
		expect(stop_headers['x-og-window']).toBe('n.s');
	});
	it('hydration() asks the page to key islands by the app’s attribute', async () => {
		let asked: unknown;
		const o = createOgygia(
			fake({
				settled: () => true,
				hydration: (k) => ((asked = k), { measured: true, islands: [] })
			}),
			{ islandKey: 'data-block-id' }
		);
		await o.hydration();
		expect(asked).toBe('data-block-id');
	});
	it('profile() keeps its own kind over the profiler JSON', async () => {
		const o = createOgygia({
			evaluate: async () => true as never,
			get: async () => ({
				status: 200,
				body: JSON.stringify({ kind: 'page', id: 'z', target: { page: '/', runs: [1] } })
			})
		});
		const r = await o.profile('/');
		expect(r.kind).toBe('profile');
		expect((r as { mode?: string }).mode).toBe('page');
		expect(o.reports).toHaveLength(1);
	});
});
