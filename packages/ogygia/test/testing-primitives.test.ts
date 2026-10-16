import { describe, it, expect } from 'vitest';
import { checkBudget, ogygiaMatchers, compare, toMarkdown, createOgygia, type OgygiaReport } from '../src/testing/index.js';

const page = {
	kind: 'page',
	url: '/x',
	nav: null,
	vitals: [
		{ key: 'lcp', label: 'LCP', value: 1800, rating: 'good' },
		{ key: 'cls', label: 'CLS', value: 0.2, rating: 'fair' }
	],
	islands: [{ fp: 'a', name: 'A', wake: 'load', load_ms: 10, queue_ms: 0, hydrate_ms: 5, t0: 10, done: 90, recovered: false, changed: false, shift: 0, longtask_ms: 0, early_ms: null, below_fold: false, cpu_ms: null }],
	findings: [{ code: 'long-hydrate', severity: 'warn', message: 'A took 80 ms', fps: ['a'], names: ['A'] }],
	blocking: [],
	bytes: [],
	longtask_ms: 120,
	cpu: null
} as unknown as OgygiaReport;

const profile = (score: number, runs: number[], findings: { code: string; severity: string; message: string }[] = []) =>
	({ kind: 'profile', id: 'x', target: { page: '/x', runs }, score: { score, grade: 'B', categories: [], missing: [] }, forecast: null, findings, assets: { totals: { js: 200_000, wire: 90_000, lazy_js: 0 } }, links: { html: '', json: '' } }) as unknown as OgygiaReport;

describe('checkBudget', () => {
	it('reads each report kind', () => {
		expect(checkBudget(page, { lcp: 2500, cls: 0.1, islandWakeMs: 100 })).toEqual([
			{ key: 'lcp', measured: 1800, limit: 2500, ok: true },
			{ key: 'cls', measured: 0.2, limit: 0.1, ok: false },
			{ key: 'islandWakeMs', measured: 80, limit: 100, ok: true }
		]);
		const p = profile(82, [100, 140, 120]);
		expect(checkBudget(p, { score: 80, renderMs: 110, jsBytes: 250_000 }).map((l) => [l.key, l.ok])).toEqual([
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
		expect(ogygiaMatchers.toHaveNoFindings(page).message()).toContain('[warn] long-hydrate: A took 80 ms');
	});
	it('toHydrateCleanly names the island and the first difference', () => {
		const hyd = {
			kind: 'hydration',
			measured: true,
			islands: [
				{ fp: 'c', name: 'Clock', wake: 'load', status: 'changed', reason: '', diff: { hunks: [{ ops: [{ op: 'del', text: 'server' }, { op: 'add', text: 'browser' }] }], removed: 1, added: 1, partial: false } },
				{ fp: 'h', name: 'Healthy', wake: 'load', status: 'clean', reason: '', diff: null }
			]
		} as unknown as OgygiaReport;
		const r = ogygiaMatchers.toHydrateCleanly(hyd);
		expect(r.pass).toBe(false);
		expect(r.message()).toContain('Clock: changed — −server +browser');
		expect(ogygiaMatchers.toHydrateCleanly(hyd, { allow: ['changed'] }).pass).toBe(true);
	});
});

describe('compare / toMarkdown', () => {
	it('what moved between two runs of the same test', () => {
		const base = [{ test: 't', reports: [profile(80, [100], [{ code: 'old', severity: 'warn', message: 'old one' }])] }];
		const head = [{ test: 't', reports: [profile(86, [80], [{ code: 'new', severity: 'warn', message: 'new one' }])] }];
		const d = compare(base, head);
		expect(d[0]).toMatchObject({ score: { base: 80, head: 86 }, renderMs: { base: 100, head: 80 } });
		expect(d[0].findings.added).toEqual(['new: new one']);
		expect(d[0].findings.fixed).toEqual(['old: old one']);
		const md = toMarkdown(d);
		expect(md).toContain('score 80 → 86');
		expect(md).toContain('server render 100 → 80 ms');
		expect(toMarkdown(compare(base, base))).toContain('no change');
	});

	it('the files behind a JS move, known by what they hold (hashed names change every build)', () => {
		const withFiles = (files: { url: string; bytes: number; contains?: string[]; lazy?: boolean }[]) => {
			const r = profile(80, [100]) as unknown as { assets: { totals: { js: number; wire: number; lazy_js: number }; files: unknown[] } };
			const js = files.filter((f) => !f.lazy).reduce((s, f) => s + f.bytes, 0);
			r.assets = { totals: { js, wire: 0, lazy_js: 0 }, files: files.map((f) => ({ kind: 'script', ...f })) };
			return r as unknown as OgygiaReport;
		};
		const base = [{ test: 't', reports: [withFiles([
			{ url: '/_app/a-HASH1.js', bytes: 40_000, contains: ['svelte runtime'] },
			{ url: '/_app/b-HASH1.js', bytes: 30_000, contains: ['src/lib/Old.svelte'] }
		])] }];
		const head = [{ test: 't', reports: [withFiles([
			// same file, new hash, grew
			{ url: '/_app/a-HASH2.js', bytes: 52_000, contains: ['svelte runtime'] },
			{ url: '/_app/c-HASH2.js', bytes: 120_000, contains: ['src/lib/Editor.svelte', '@codemirror/state'] }
		])] }];
		const d = compare(base, head)[0];
		expect(d.js?.changes).toEqual(['new src/lib/Editor.svelte, @codemirror/state 117 KB', 'grew svelte runtime 39 KB → 51 KB', 'gone src/lib/Old.svelte 29 KB']);
		expect(toMarkdown([d])).toContain('JS at start 68 → 168 KB: new src/lib/Editor.svelte, @codemirror/state 117 KB; grew svelte runtime');
		// the same file, same size, now loading at start: an island's wake changed
		const later = [{ test: 't', reports: [withFiles([{ url: '/_app/e-H1.js', bytes: 400_000, contains: ['src/lib/Editor.svelte'], lazy: true }])] }];
		const eager = [{ test: 't', reports: [withFiles([{ url: '/_app/e-H2.js', bytes: 400_000, contains: ['src/lib/Editor.svelte'] }])] }];
		expect(compare(later, eager)[0].js?.changes).toEqual(['now at start src/lib/Editor.svelte 391 KB (loaded later before)']);
		expect(compare(eager, later)[0].js?.changes).toEqual(['now loads later src/lib/Editor.svelte 391 KB']);
	});
});

describe('compare: hydration, session counts, vitals', () => {
	const hyd = (islands: { key?: string; name: string; status: string }[]) =>
		({ kind: 'hydration', measured: true, islands: islands.map((i, n) => ({ fp: 'f' + n, wake: 'load', reason: '', diff: null, ...i })) }) as unknown as OgygiaReport;
	const sess = (counts: Record<string, number>) => ({ kind: 'session', counts, findings: [], navigations: [], interactions: [], requests: [] }) as unknown as OgygiaReport;
	const pg = (lcp: number, cls: number) => ({ ...(page as object), vitals: [{ key: 'lcp', value: lcp }, { key: 'cls', value: cls }], findings: [] }) as unknown as OgygiaReport;

	it('names the island instance that broke and the one that was fixed', () => {
		const base = [{ test: 't', reports: [hyd([{ key: 'Carousel#1', name: 'Carousel', status: 'clean' }, { key: 'Carousel#2', name: 'Carousel', status: 'failed' }])] }];
		const head = [{ test: 't', reports: [hyd([{ key: 'Carousel#1', name: 'Carousel', status: 'failed' }, { key: 'Carousel#2', name: 'Carousel', status: 'clean' }])] }];
		expect(compare(base, head)[0].hydration).toEqual({ broke: ['Carousel#1: clean → failed'], fixed: ['Carousel#2: failed → clean'] });
	});
	it('reports without keys compare as a tally per name and status', () => {
		const base = [{ test: 't', reports: [hyd([{ name: 'Carousel', status: 'failed' }, { name: 'Carousel', status: 'clean' }])] }];
		const head = [{ test: 't', reports: [hyd([{ name: 'Carousel', status: 'failed' }, { name: 'Carousel', status: 'failed' }])] }];
		expect(compare(base, head)[0].hydration).toEqual({ broke: ['Carousel: failed ×1'], fixed: [] });
	});
	it('session counts and vitals past the noise, in the markdown', () => {
		const base = [{ test: 't', reports: [pg(1800, 0.05), sess({ errors: 0, shifts: 1, slow: 0, cls: 0.03 })] }];
		const head = [{ test: 't', reports: [pg(2400, 0.06), sess({ errors: 2, shifts: 1, slow: 0, cls: 0.2 })] }];
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
	it('a session meets a CLS budget', () => {
		expect(checkBudget(sess({ cls: 0.2 }), { cls: 0.1 })).toEqual([{ key: 'cls', measured: 0.2, limit: 0.1, ok: false }]);
	});
});

describe('createOgygia', () => {
	it('drives any page driver, and tells you when the page has no testing API', async () => {
		const o = createOgygia({ evaluate: async () => false as never }, { timeout: 50 });
		await expect(o.page()).rejects.toThrow('devtools: true');
	});
	/** A page driver over a fake in-page API: `present()` says whether the API is in the page now. */
	const fake = (api: Record<string, (...a: unknown[]) => unknown>, present: () => boolean = () => true) => ({
		evaluate: async (fn: unknown, arg: unknown) => {
			if (arg === null) return (String(fn).includes('location') ? 'http://app.test/elsewhere' : present()) as never;
			const [n, a] = arg as [string, unknown[]];
			return api[n](...a) as never;
		},
		wait: async () => {}
	});
	const session = { duration_ms: 1, counts: {}, findings: [], interactions: [], by_island: {}, requests: [], cpu: null, navigations: [], timeline: [], unmeasured: [] };

	it('record(): a page that left for another document says so, with the actions’ own error as the cause', async () => {
		let here = true;
		const o = createOgygia(fake({ settled: () => true, record_start: () => true, record_stop: () => session }, () => here), { timeout: 50 });
		const boom = new Error('the button was gone');
		const err = await o
			.record(async () => {
				here = false; // the click reloaded the page into one with no testing API
				throw boom;
			})
			.catch((e: Error) => e);
		expect((err as Error).message).toContain('went to another document');
		expect((err as Error).message).toContain('http://app.test/elsewhere');
		expect((err as Error).message).not.toContain('devtools: true');
		expect((err as Error).cause).toBe(boom);
	});
	it('record(): the actions’ error still surfaces when the page stayed', async () => {
		const o = createOgygia(fake({ settled: () => true, record_start: () => true, record_stop: () => session }));
		await expect(o.record(async () => Promise.reject(new Error('plain failure')))).rejects.toThrow('plain failure');
	});
	it('record({ blockNavigation }): the driver holds the loads back and the page lists them', async () => {
		let stop_args: unknown[] = [];
		const held = [{ url: 'http://app.test/', t: 120 }];
		const o = createOgygia({
			...fake({
				settled: () => true,
				record_start: () => true,
				record_stop: (...a) => ((stop_args = a), { ...session, navigations: [{ url: 'http://app.test/', t: 120, after: 'button.reload', island: 'Hero' }] })
			}),
			blockNavigation: async () => ({ stop: async () => held })
		});
		const r = await o.record(async () => {}, { blockNavigation: true });
		expect(stop_args).toEqual([held]);
		expect(r.navigations[0]).toMatchObject({ after: 'button.reload', island: 'Hero' });
		await expect(createOgygia(fake({ settled: () => true })).record(async () => {}, { blockNavigation: true })).rejects.toThrow('blockNavigation()');
	});
	it('hydration() asks the page to key islands by the app’s attribute', async () => {
		let asked: unknown;
		const o = createOgygia(fake({ settled: () => true, hydration: (k) => ((asked = k), { measured: true, islands: [] }) }), { islandKey: 'data-block-id' });
		await o.hydration();
		expect(asked).toBe('data-block-id');
	});
	it('profile() keeps its own kind over the profiler JSON', async () => {
		const o = createOgygia({ evaluate: async () => true as never, get: async () => ({ status: 200, body: JSON.stringify({ kind: 'page', id: 'z', target: { page: '/', runs: [1] } }) }) });
		const r = await o.profile('/');
		expect(r.kind).toBe('profile');
		expect((r as { mode?: string }).mode).toBe('page');
		expect(o.reports).toHaveLength(1);
	});
});
