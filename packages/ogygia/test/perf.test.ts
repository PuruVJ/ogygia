/**
 * `ogygia perf` + `ogygia bisect` — the pure modules: a report folded into a snapshot, a snapshot
 * judged against a baseline under a budget, the verdict as a PR comment, and the binary search
 * over commits with noise, skips and an empty range.
 */
import { describe, expect, it } from 'vitest';
import { measure, snapshot_page, type PerfSnapshot, type ReportLike } from '../src/perf/measure.js';
import { verdict, DEFAULT_BUDGET } from '../src/perf/compare.js';
import { markdown, summary } from '../src/perf/report.js';
import { bisect } from '../src/perf/bisect.js';

const report = (over: Partial<ReportLike> = {}): ReportLike => ({
	node: 'v26',
	target: { runs: [40, 44, 42, 41, 43], page: '/p' },
	summary: { busy_ms: 120 },
	timeline: { wait_ms: 80, phases: [{ phase: 'load', cpu_ms: 10, wait_ms: 60 }, { phase: 'render', cpu_ms: 30, wait_ms: 0 }] },
	cold: { ms: 200 },
	ogygia: {
		seed_bytes: 100 * 1024,
		tail_bytes: 20 * 1024,
		islands: 3,
		island_rows: [
			{ js_bytes: 100_000, modules: ['/a.js', '/shared.js'] },
			{ js_bytes: 60_000, modules: ['/b.js', '/shared.js'] },
			{ js_bytes: null, modules: [] }
		]
	},
	components: [{ name: 'Card', self_ms: 30, total_ms: 60 }, { name: '_page', self_ms: 1, total_ms: 200 }],
	hot_functions: [{ name: 'fmt', file: 'lib/fmt.ts', self_ms: 12 }],
	paths: [{ owner: { name: 'Card' }, ms: 40, functions: [1, 2, 3] }],
	findings: [{ code: 'seed-large', severity: 'warn' }, { code: 'summary', severity: 'info' }],
	...over
});

describe('measure', () => {
	it('folds a report into a page snapshot: medians, bytes, unique island JS, top rows, warnings', () => {
		const s = snapshot_page('/p', report());
		expect(s).toMatchObject({ page: '/p', render_p50: 42, busy_ms: 120, wait_ms: 80, cold_extra_ms: 158, seed_kb: 100, props_kb: 20, islands: 3 });
		// /shared.js counted once: a=100k over 2 modules → 50k unique share for the second island's shared module
		expect(s.islands_js_kb).toBe(Math.round(((100_000 + 60_000 / 2) / 1024) * 10) / 10);
		expect(s.components[0]).toEqual({ name: 'Card', self_ms: 30, total_ms: 60 });
		expect(s.paths).toEqual([{ owner: 'Card', ms: 40, fns: 3 }]);
		expect(s.warnings).toEqual(['seed-large']);
		expect(s.phases).toEqual({ load: 70, render: 30 });
		// an older server answering less: nothing throws, zeros
		expect(snapshot_page('/x', {})).toMatchObject({ render_p50: 0, runs: [], seed_kb: 0, components: [], warnings: [] });
	});

	it('drives the profiler over HTTP with the key, one page at a time, and explains failures', async () => {
		const calls: string[] = [];
		const fake = (async (url: string | URL | Request, init?: RequestInit) => {
			const u = String(url);
			calls.push(u + ' ' + new Headers(init?.headers).get('x-profiler-key'));
			if (u.includes('p=%2Fbusy')) return new Response('{}', { status: 409 });
			if (u.includes('p=%2Flocked')) return new Response('', { status: 401 });
			if (u.includes('p=%2Fhtml')) return new Response('<html>', { status: 200 });
			return new Response(JSON.stringify(report({ target: { runs: [10, 12, 11], page: u.includes('%2Fb') ? '/b' : '/a' } })), { status: 200 });
		}) as typeof fetch;
		const snap = await measure({ url: 'http://h/', pages: ['/a', '/b'], runs: 3, key: 'k', fetch: fake, label: 'sha1' });
		expect(calls).toEqual(['http://h/__profiler/page?p=%2Fa&runs=3&format=json k', 'http://h/__profiler/page?p=%2Fb&runs=3&format=json k']);
		expect(snap.pages.map((p) => p.page)).toEqual(['/a', '/b']);
		expect(snap.label).toBe('sha1');
		expect(snap.node).toBe('v26');
		await expect(measure({ url: 'http://h', pages: ['/busy'], fetch: fake })).rejects.toThrow(/busy/);
		await expect(measure({ url: 'http://h', pages: ['/locked'], fetch: fake })).rejects.toThrow(/key right/);
		await expect(measure({ url: 'http://h', pages: ['/html'], fetch: fake })).rejects.toThrow(/not JSON/);
		await expect(measure({ url: 'http://h', pages: ['nope'], fetch: fake })).rejects.toThrow(/path on the site/);
	});
});

const snap = (pages: Partial<ReturnType<typeof snapshot_page>>[]): PerfSnapshot => ({
	version: 1,
	at: 0,
	node: 'v',
	pages: pages.map((p) => ({ ...snapshot_page(p.page ?? '/p', report()), ...p }))
});

describe('verdict', () => {
	it('relative growth over the floor fails; small growth on a tiny page does not; caps are absolute', () => {
		const base = snap([{ page: '/p', render_p50: 100, busy_ms: 50 }, { page: '/tiny', render_p50: 2 }]);
		const cur = snap([{ page: '/p', render_p50: 112, busy_ms: 55 }, { page: '/tiny', render_p50: 3 }]);
		const v = verdict(base, cur);
		expect(v.ok).toBe(false);
		expect(v.failures).toEqual(['/p: render grew 12 ms (8% allowed)']);
		const p = v.pages[0];
		expect(p.rows[0]).toMatchObject({ metric: 'render (median)', base: 100, cur: 112, delta: 12, pct: 12, over: true });
		expect(p.rows.find((r) => r.metric === 'CPU busy')).toMatchObject({ delta: 5, over: false }); // 10% < 15%
		expect(v.pages[1].failures).toEqual([]); // +1 ms on a 2 ms page: under the 5 ms floor
		// an absolute cap catches a page that was always over it, even with no growth
		const capped = verdict(base, cur, { render_max_ms: 50, pages: { '/tiny': { render_max_ms: 1 } } });
		expect(capped.failures).toEqual(['/p: render 112 ms is over the 50 ms cap', '/tiny: render 3 ms is over the 1 ms cap']);
	});

	it('a new page is judged by caps only; a page the run did not measure is listed; a named finding fails', () => {
		const base = snap([{ page: '/old' }]);
		const cur = snap([{ page: '/new', seed_kb: 400, warnings: ['seed-whole'] }]);
		const v = verdict(base, cur, { seed_max_kb: 300, fail_on: ['seed-whole'] });
		expect(v.pages[0].fresh).toBe(true);
		expect(v.missing).toEqual(['/old']);
		expect(v.failures).toEqual(['/new: the seed is 400 KB, over the 300 KB cap', '/new: finding seed-whole appeared']);
		expect(v.pages[0].rows[0].delta).toBeNull();
	});

	it('movers: a component whose self time grew past its own budget fails; functions and paths are listed', () => {
		const base = snap([{ page: '/p', components: [{ name: 'Card', self_ms: 10, total_ms: 20 }], functions: [{ name: 'fmt', file: 'f.ts', self_ms: 5 }], paths: [{ owner: 'Card', ms: 12, fns: 2 }] }]);
		const cur = snap([{ page: '/p', components: [{ name: 'Card', self_ms: 14, total_ms: 26 }, { name: 'New', self_ms: 3, total_ms: 3 }], functions: [{ name: 'fmt', file: 'f.ts', self_ms: 8 }], paths: [{ owner: 'Card', ms: 20, fns: 3 }] }]);
		const v = verdict(base, cur);
		expect(v.failures).toEqual(['/p: Card self time grew 4 ms (25% allowed)']);
		expect(v.pages[0].movers.map((m) => `${m.kind}:${m.name}:${m.delta}:${m.over}`)).toEqual(['path:Card:8:false', 'component:Card:4:true', 'component:New:3:false', 'function:fmt:3:false']);
		expect(DEFAULT_BUDGET.component_pct).toBe(25);
	});

	it('the markdown comment and the terminal summary carry the verdict', () => {
		const base = snap([{ page: '/p', render_p50: 100 }]);
		const cur = snap([{ page: '/p', render_p50: 130, warnings: ['seed-large', 'hot-list'] }]);
		const v = verdict(base, cur);
		const md = markdown(v, { title: 'Performance (abc123)', links: { '/p': { cur: 'http://h/r/1', base: 'http://h/r/0' } } });
		expect(md).toContain('### Performance (abc123): ❌ 1 budget failure');
		expect(md).toContain('- ❌ /p: render grew 30 ms (8% allowed)');
		expect(md).toContain('#### ❌ `/p` · [report](http://h/r/1) · [baseline](http://h/r/0)');
		expect(md).toContain('| render (median) | 100.0 ms | 130.0 ms | +30.0 ms (+30%) ❌ | +8% (≥ 5 ms) |');
		expect(md).toContain('**Findings that appeared:** `hot-list`');
		const ok = markdown(verdict(base, base));
		expect(ok).toContain('✅ within budget');
		expect(summary(v)).toContain('✗ /p  render 130.0 ms (+30.0 ms (+30%))');
		expect(summary(verdict(base, base))).toContain('within budget');
	});
});

describe('bisect', () => {
	const commits = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'];
	it('finds the first bad commit in log2 steps, tolerating noise under the bar', async () => {
		// c1..c4 good (≈ 100 ± 4), c5 onwards bad (≈ 180)
		const table: Record<string, number> = { c1: 101, c2: 98, c3: 104, c4: 96, c5: 178, c6: 182, c7: 180, c8: 181 };
		const measured: string[] = [];
		const r = await bisect({ commits, good_value: 100, bad_value: 180, measure: async (s) => (measured.push(s), table[s]) });
		expect(r.culprit).toBe('c5');
		expect(r.last_good).toBe('c4');
		expect(r.bar).toBe(140);
		expect(measured.length).toBeLessThanOrEqual(3);
	});
	it('skips a commit that cannot be built and still lands on the culprit', async () => {
		// the first midpoint (c4) cannot be built; the search steps around it, and when only the
		// unbuildable commit is left between good and bad it stops with the culprit it has
		const table: Record<string, number | null> = { c1: 100, c2: 100, c3: 100, c4: null, c5: 180, c6: null, c7: 180, c8: 180 };
		const r = await bisect({ commits, good_value: 100, bad_value: 180, measure: async (s) => table[s] });
		expect(r.culprit).toBe('c5');
		expect(r.last_good).toBe('c3');
		expect(r.skipped).toEqual(['c4']);
		expect(r.steps.filter((s) => s.value !== null).length).toBeLessThanOrEqual(4);
	});
	it('a range with no regression names no culprit; a measure that throws counts as a skip', async () => {
		expect((await bisect({ commits, good_value: 100, bad_value: 100, measure: async () => 100 })).culprit).toBeNull();
		const r = await bisect({ commits: ['a', 'b'], good_value: 100, bad_value: 200, measure: async (s) => { if (s === 'a') throw new Error('boom'); return 200; } });
		expect(r.skipped).toEqual(['a']);
		expect(r.culprit).toBe('b');
	});
});
