import { describe, it, expect } from 'vitest';
import { slim_profile, island_row, run_profile } from '../src/devtools/profile-store.js';

const report = {
	id: 'abc123',
	created: 1790504721678,
	target: { page: '/hell', runs: [778.5, 800.1, 818.2], runs_measured: [829, 844, 865] },
	score: { score: 50, grade: 'D', categories: [{ key: 'server', label: 'Server', score: 0, value: '800 ms' }] },
	findings: [
		{ severity: 'info', code: 'summary', message: 'Over 2894 ms…' },
		{ severity: 'info', code: 'cold', message: 'cold start' },
		{ severity: 'warn', code: 'n-plus-one', message: '16 calls…', fix: 'Batch them.' },
		{ severity: 'error', code: 'boom', message: 'bad' }
	],
	forecast: { now_ms: 800.1, after_ms: 531.3, parts: [{ title: 'Calls wait one after another', kind: 'waits-in-a-row', ms: 151.1, wait: true }] },
	ogygia: {
		seed_bytes: 261001,
		island_rows: [
			{ name: 'MegaHeader', entry: '/@id/virtual:ogygia/island/71c18fcca62d.js', fp: '08048d746a335614', wake: 'load', ssr_ms: 4.1, props_bytes: 114141, seed_refs: 0, devalue_culprit: 'config.updated (Date)', client: { p50_ms: 70.1, recovered: 0 } },
			{ name: 'Mark', entry: '/@id/virtual:ogygia/island/24fa20edb0cb.js', fp: '49d3183153fa0510', wake: 'load', ssr_ms: null, props_bytes: 2, client: null }
		]
	},
	components: [{ name: 'Icon', file: 'src/lib/Icon.svelte', self_ms: 9.89, total_ms: 10.65, instances: 298 }],
	network: { count: 25, total_ms: 407.3, sequential_ms: 323.8, calls: [{ method: 'GET', url: 'http://x/api', status: 200, wait_ms: 45.4 }] },
	links: { html: '/__profiler/report/abc123', json: '/__profiler/report/abc123.json' }
};

describe('slim_profile', () => {
	it('keeps what the dock shows, in order', () => {
		const p = slim_profile(report);
		expect(p.page).toBe('/hell');
		expect(p.render_ms).toBe(800.1); // median of the overhead-free runs, the forecast's base
		expect(p.score?.grade).toBe('D');
		expect(p.forecast?.after_ms).toBe(531.3);
		expect(p.findings.map((f) => f.code)).toEqual(['boom', 'n-plus-one', 'cold']); // no summary, errors first
		expect(p.islands[0]).toMatchObject({ name: 'MegaHeader', ssr_ms: 4.1, culprit: 'config.updated (Date)', client_p50_ms: 70.1 });
		expect(p.islands[1]).toMatchObject({ ssr_ms: null, client_p50_ms: null });
		expect(p.network?.calls[0].wait_ms).toBe(45.4);
		expect(p.links?.html).toBe('/__profiler/report/abc123');
		expect(JSON.stringify(p).length).toBeLessThan(4000);
	});

	it('keeps the score\'s lost points, what was left out, the score before, and the page\'s files', () => {
		const p = slim_profile({
			...report,
			score: { score: 86, grade: 'B', categories: [{ key: 'js', label: 'JS at start', score: 54, value: '618 KB', lost: 13.8, detail: ['big.js 441 KB (@codemirror/view)'] }], missing: [{ key: 'loading', label: 'Loading', why: 'no visit' }] },
			since: { score: { a: 81, b: 86, a_grade: 'B', b_grade: 'B', moved: [] } },
			assets: { totals: { js: 632832, lazy_js: 0, wire: 223000 }, files: [{ url: 'http://x/_app/big.js?v=1', kind: 'script', bytes: 451584, contains: ['@codemirror/view', 'src/lib/Editor.svelte'] }] }
		});
		expect(p.score?.categories[0]).toMatchObject({ lost: 13.8, detail: ['big.js 441 KB (@codemirror/view)'] });
		expect(p.score?.missing).toEqual([{ label: 'Loading', why: 'no visit' }]);
		expect(p.score?.was).toEqual({ score: 81, grade: 'B' });
		expect(p.assets?.files[0]).toMatchObject({ name: 'big.js', bytes: 451584, contains: ['@codemirror/view', 'src/lib/Editor.svelte'] });
	});

	it('survives a report missing everything', () => {
		const p = slim_profile({});
		expect(p.islands).toEqual([]);
		expect(p.score).toBeNull();
		expect(p.render_ms).toBe(0);
	});
});

describe('island_row', () => {
	const p = slim_profile(report);
	it('joins by fingerprint, then by entry', () => {
		expect(island_row(p, '08048d746a335614', null)?.name).toBe('MegaHeader');
		// the same island with other props: another fingerprint, same entry chunk
		expect(island_row(p, 'ffff', './@id/virtual:ogygia/island/71c18fcca62d.js')?.name).toBe('MegaHeader');
		expect(island_row(p, 'ffff', null)).toBeNull();
		expect(island_row(null, 'x', 'y')).toBeNull();
	});
});

describe('the slim profile keeps what the browser cannot read', () => {
	it("the page's Cache-Control, when the report has it", () => {
		expect(slim_profile({ ...report, target: { ...report.target, cache_control: 'private, no-store' } }).cache_control).toBe('private, no-store');
		expect(slim_profile(report).cache_control).toBeUndefined();
	});
	it('a prerendered page: the file served, or a route that prerenders', () => {
		expect(slim_profile({ ...report, target: { ...report.target, prerendered: 'file' } }).prerendered).toBe('file');
		expect(slim_profile({ ...report, target: { ...report.target, prerendered: null } }).prerendered).toBeUndefined();
	});
	it("an island's line that draws differently in the browser: a rendered value before a guard", () => {
		const rows = report.ogygia.island_rows.map((r, i) =>
			i === 0
				? {
						...r,
						hazards: [
							{ file: 'src/lib/MegaHeader.svelte', line: 4, code: "if (typeof window !== 'undefined') {", kind: 'browser', reads: 'typeof window', guard: true },
							{ file: 'src/lib/MegaHeader.svelte', line: 9, code: 'const now = Date.now();', kind: 'browser', reads: 'Date.now(' }
						]
					}
				: r
		);
		const p = slim_profile({ ...report, ogygia: { ...report.ogygia, island_rows: rows } });
		expect(p.islands[0].hazard).toEqual({ file: 'src/lib/MegaHeader.svelte', line: 9, kind: 'browser', reads: 'Date.now(' });
		expect(p.islands[1].hazard).toBeUndefined();
	});
});

describe('run_profile when the profiler refuses', () => {
	it("a heap too full to profile: the profiler's sentence, not its JSON", async () => {
		const said = "The server's heap is 77% full (1232 of 1596 MB): profiling now could run it out of memory and end the process. Restart the server, then profile once.";
		const real = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ error: said }), { status: 503 })) as typeof fetch;
		try {
			await expect(run_profile('/hell')).rejects.toThrow(said);
		} finally {
			globalThis.fetch = real;
		}
	});
	it('another failure: its status and its words', async () => {
		const real = globalThis.fetch;
		globalThis.fetch = (async () => new Response('Give a path on this site, like /docs/overview.', { status: 400 })) as typeof fetch;
		try {
			await expect(run_profile('x')).rejects.toThrow('the profiler answered 400: Give a path on this site, like /docs/overview.');
		} finally {
			globalThis.fetch = real;
		}
	});
});
