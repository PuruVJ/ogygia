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

describe('createOgygia', () => {
	it('drives any page driver, and tells you when the page has no testing API', async () => {
		const o = createOgygia({ evaluate: async () => false as never }, { timeout: 50 });
		await expect(o.page()).rejects.toThrow('devtools: true');
	});
	it('profile() keeps its own kind over the profiler JSON', async () => {
		const o = createOgygia({ evaluate: async () => true as never, get: async () => ({ status: 200, body: JSON.stringify({ kind: 'page', id: 'z', target: { page: '/', runs: [1] } }) }) });
		const r = await o.profile('/');
		expect(r.kind).toBe('profile');
		expect((r as { mode?: string }).mode).toBe('page');
		expect(o.reports).toHaveLength(1);
	});
});
