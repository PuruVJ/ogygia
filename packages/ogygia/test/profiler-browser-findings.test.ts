// The report's browser findings are the devtools Page tab's, run on the visit the beacon sent: each
// planted problem is named on its island (by the render's own name), the report's own codes are
// left to it, and a clean visit says nothing.
import { expect, test } from 'vitest';
import { parse_visit, merge_visits } from '../src/profiler/visit.ts';
import { browser_findings, browser_page_report } from '../src/profiler/browser-findings.ts';

const rows = [
	{ fp: 'aaaaaaaa11111111', entry: '/src/lib/Menu.svelte', name: 'Menu' },
	{ fp: 'bbbbbbbb22222222', entry: '/src/lib/Grower.svelte', name: 'Grower' },
	{ fp: 'cccccccc33333333', entry: '/src/lib/Broken.svelte', name: 'Broken' },
	{ fp: 'dddddddd44444444', entry: '/src/lib/Below.svelte', name: 'Below' }
];

const raw = {
	at: 1,
	nav: { req_start: 1, res_start: 100, res_end: 120, dcl: 300, load: 400 },
	paints: { fcp: 250, lcp: 260 },
	viewport: [1200, 800],
	resources: [],
	longtasks: [{ t: 500, ms: 120 }],
	islands: [
		// Menu: clicked at 450, hydrated at 700; one 120 ms hydrate step
		{ fp: 'aaaaaaaa11111111', entry: '/src/lib/Menu.svelte', t0: 300, loaded: 480, turn: 500, done: 700 },
		// Grower: moved the layout just after it woke
		{ fp: 'bbbbbbbb22222222', entry: '/src/lib/Grower.svelte', t0: 300, loaded: 350, turn: 360, done: 380 },
		{ fp: 'dddddddd44444444', entry: '/src/lib/Below.svelte', t0: 300, loaded: 320, turn: 330, done: 340 }
	],
	firsts: [{ fp: 'aaaaaaaa11111111', t: 450, type: 'pointerdown' }],
	shifts: [{ t: 400, value: 0.2, fp: 'bbbbbbbb22222222' }],
	regions: [
		{ fp: 'aaaaaaaa11111111', entry: '/src/lib/Menu.svelte', hydrated: true, top: 0, height: 60 },
		{ fp: 'bbbbbbbb22222222', entry: '/src/lib/Grower.svelte', hydrated: true, top: 100, height: 200 },
		{ fp: 'cccccccc33333333', entry: '/src/lib/Broken.svelte', failed: 'boom is not defined', top: 300, height: 50 },
		{ fp: 'dddddddd44444444', entry: '/src/lib/Below.svelte', wake: 'idle', hydrated: true, top: 2400, height: 50 }
	],
	vitals: { lcp: 260, cls: 0.2 }
};

test('each planted problem, on its island, in the report', () => {
	const visit = parse_visit('/lab', raw)!;
	expect(visit.regions).toHaveLength(4);
	expect(visit.islands[0].turn).toBe(500);
	const found = browser_findings(browser_page_report(visit, rows));
	const by = Object.fromEntries(found.map((f) => [f.code, f]));
	expect(by['hydrate-failed'].message).toContain('Broken failed to hydrate: boom is not defined');
	expect(by['hydrate-failed'].severity).toBe('warn');
	expect(by['early-click'].message).toContain('Menu');
	expect(by['long-hydrate'].message).toContain('Menu');
	expect(by['hydration-shift'].fps).toEqual(['bbbbbbbb22222222']);
	expect(by['eager-offscreen'].message).toContain('Below');
	// the report makes these its own way
	for (const code of ['recovered', 'never-woke', 'vital-cls', 'render-blocking']) expect(by[code]).toBeUndefined();
	for (const f of found) expect(f.message.startsWith('In the browser: ')).toBe(true);
});

test('a clean visit has no browser findings; a later record of the visit updates the regions', () => {
	const clean = parse_visit('/lab', {
		...raw,
		longtasks: [],
		firsts: [],
		shifts: [],
		islands: [raw.islands[1]],
		regions: [{ ...raw.regions[1] }],
		vitals: {}
	})!;
	expect(browser_findings(browser_page_report(clean, rows))).toEqual([]);

	const early = parse_visit('/lab', { ...raw, regions: [{ ...raw.regions[0], hydrated: false }] })!;
	const late = parse_visit('/lab', { ...raw, regions: [raw.regions[0]] })!;
	expect(merge_visits(early, late).regions?.[0].hydrated).toBe(true);
});

test('a page with more files than the visit lists: counts and bytes cover all of them', () => {
	const resources = Array.from({ length: 3 }, (_, i) => ({ url: `/a${i}.js`, type: 'script', start: i, end: i + 1, transfer: 100 }));
	const totals = [
		{ type: 'script', count: 300, transfer: 30_000, size: 90_000 },
		{ type: 'img', count: 40, transfer: 400_000, size: 400_000 }
	];
	const v = parse_visit('/lab', { ...raw, resources, resource_totals: totals, resources_all: 340 })!;
	expect(v.resources_all).toBe(340);
	const report = browser_page_report(v, rows)!;
	expect(report.bytes.find((b) => b.type === 'script')).toMatchObject({ count: 300, transfer: 30_000 });
	expect(report.bytes[0].type).toBe('img'); // the heaviest first
	// totals that claim no more files than listed are dropped (the list is the truth then)
	expect(parse_visit('/lab', { ...raw, resources, resource_totals: totals, resources_all: 3 })!.resource_totals).toBeUndefined();
	// the record that saw more files wins a merge
	const early = parse_visit('/lab', { ...raw, resources, resource_totals: [{ type: 'script', count: 10, transfer: 1, size: 1 }], resources_all: 10 })!;
	expect(merge_visits(early, v).resources_all).toBe(340);
	expect(merge_visits(v, early).resources_all).toBe(340);
});

test("a lazy island's code counts at start only when it loaded before the load event (a scroll right after is not the start)", async () => {
	const { start_js } = await import('../src/profiler/report.ts');
	const asset = (url: string, lazy: boolean) => ({ url, kind: 'script' as const, blocking: false, via: 'island' as const, bytes: 100_000, wire: 30_000, ...(lazy ? { lazy: true } : {}) });
	const assets = {
		assets: [asset('https://a.test/entry.js', false), asset('https://a.test/editor.js', true)],
		missed: [],
		html: { bytes: 1, wire: 1 },
		inline: { script: 0, style: 0 },
		totals: { js: 100_000, js_wire: 30_000, css: 0, css_wire: 0, font: 0, image: 0, wire: 30_000, lazy_js: 100_000, blocking: 0, blocking_count: 0, js_files: 1 }
	};
	const visit_with = (editor_start: number) =>
		parse_visit('/p', { ...raw, nav: { req_start: 0, res_start: 10, res_end: 20, dcl: 200, load: 400 }, resources: [{ url: 'https://a.test/entry.js', type: 'script', start: 50, end: 90 }, { url: 'https://a.test/editor.js', type: 'script', start: editor_start, end: editor_start + 40 }] })!;
	// on the first screen: loaded before load → counted at start
	expect(start_js({ assets, visit: visit_with(300) })!.js).toBe(200_000);
	// scrolled to right after load: still lazy
	expect(start_js({ assets, visit: visit_with(900) })!.js).toBe(100_000);
});

test('the inline beacon for pages without the runtime is valid JS', async () => {
	const { BEACON_STANDALONE_JS } = await import('../src/profiler/beacon-standalone.ts');
	expect(() => new Function(BEACON_STANDALONE_JS)).not.toThrow();
});

test('bad region records are dropped', () => {
	const v = parse_visit('/lab', { ...raw, regions: [{ fp: 'nope', top: 0, height: 1 }, { fp: 'aaaaaaaa11111111', top: 'x', height: 1 }, { fp: 'aaaaaaaa11111111', top: 5, height: 9, failed: 7 }] })!;
	expect(v.regions).toEqual([{ fp: 'aaaaaaaa11111111', top: 5, height: 9 }]);
});

test('a hole that kept its fallback reaches the report, named from the hole rows', () => {
	const v = parse_visit('/lab', {
		...raw,
		holes_failed: [
			{ id: '7c4afc210dc0', reason: 'redirected', final_path: '/account/', attempts: 1, t: 900 },
			{ id: 'c0d0e795dedc', reason: 'error', message: 'status 500', attempts: 3, t: 1900 },
			{ id: 'bad', reason: 'nope' }
		]
	})!;
	expect(v.holes_failed?.map((h) => h.id)).toEqual(['7c4afc210dc0', 'c0d0e795dedc']);
	// the early visit and the hide-time one fold: each hole once
	expect(merge_visits(v, v).holes_failed).toHaveLength(2);
	const names: Record<string, string> = { '7c4afc210dc0': 'Greeting', c0d0e795dedc: 'BrokenHole' };
	const f = browser_findings(browser_page_report(v, rows, undefined, undefined, (id) => names[id])).filter((x) => x.code === 'hole-failed');
	expect(f.map((x) => x.message.split(' never')[0])).toEqual(['In the browser: Greeting', 'In the browser: BrokenHole']);
	expect(f[0].message).toContain('redirected to /account/');
	expect(f[1].message).toContain('failed 3 times (status 500)');
});

test("an island whose own file was gone reaches the report, named from the island rows", () => {
	const entry = rows[0]?.entry ?? '/_app/immutable/og-region.0123456789ab.js';
	const v = parse_visit('/lab', {
		...raw,
		entry_fallbacks: [{ entry, src: '/_app/immutable/og-region.0123456789ab.Gone1234.js', recovered: true }, { entry: 7 }]
	})!;
	expect(v.entry_fallbacks).toHaveLength(1);
	expect(merge_visits(v, v).entry_fallbacks).toHaveLength(1);
	const f = browser_findings(browser_page_report(v, rows)).find((x) => x.code === 'island-file-gone');
	expect(f?.message).toContain('In the browser: An island could not load its own file (og-region.0123456789ab.Gone1234.js)');
	if (rows[0]) expect(f?.message).toContain(`${rows[0].name} woke on the current build`);
	// the page wrote its entry relative to itself (a nested route): named all the same, by its file
	const nested = parse_visit('/lab', { ...raw, entry_fallbacks: [{ entry: '../../src/lib/Menu.svelte', src: '/gone.js', recovered: true }] })!;
	const g = browser_findings(browser_page_report(nested, rows)).find((x) => x.code === 'island-file-gone');
	expect(g?.message).toContain('Menu woke on the current build');
});

test('content-named files fetched again reach the report, named from the island rows, even with no island awake', () => {
	const entry = rows[0]?.entry ?? '/_app/immutable/og-region.0123456789ab.js';
	const v = parse_visit('/lab', {
		...raw,
		islands: [],
		refetched: [
			{ url: 'https://a.test/_app/immutable/og-region.0123456789ab.Hh12Kk34.js', how: 'revalidated', bytes: 0, ms: 20, entry },
			{ url: 'https://a.test/_app/immutable/og-runtime.Zz99.js', how: 'revalidated', bytes: 0, ms: 35, runtime: true },
			{ url: 'https://a.test/x.js', how: 'cached', bytes: 1 },
			{ url: 7 }
		]
	})!;
	expect(v.refetched).toHaveLength(2);
	expect(merge_visits(v, { ...v, refetched: undefined }).refetched).toHaveLength(2);
	const f = browser_findings(browser_page_report(v, rows)).find((x) => x.code === 'files-fetched-again');
	expect(f?.message).toContain('In the browser: The browser asked the server again for 2 files it already had');
	expect(f?.message).toContain(`(the runtime and ${rows[0]?.name ?? 'og-region.0123456789ab.Hh12Kk34.js'})`);
	// an island a hole's answer carried: the page's render never saw it, so it is named by its hole
	const in_hole = parse_visit('/lab', {
		...raw,
		refetched: [{ url: 'https://a.test/_app/immutable/og-region.fedcba987654.Qq11.js', how: 'revalidated', bytes: 0, ms: 9, entry: './_app/immutable/og-region.fedcba987654.js', hole: '040dd4f0cdb2' }]
	})!;
	expect(in_hole.refetched?.[0].hole).toBe('040dd4f0cdb2');
	const g = browser_findings(browser_page_report(in_hole, rows, undefined, undefined, (id) => (id === '040dd4f0cdb2' ? 'HoleProbe' : `the hole ${id}`))).find((x) => x.code === 'files-fetched-again');
	expect(g?.message).toContain('(the island in HoleProbe)');
});

test('the slowest interaction reaches the report: parsed, the slower of two records kept, a built island file named', () => {
	const row = rows[0];
	const fp = row?.fp ?? '0123456789abcdef';
	// a location is its identity plus a content hash: the script's file names the island
	const loc = (row?.entry ?? '/_app/immutable/og-region.0123456789ab.js').replace(/\.js$/, '.Hh12Kk34.js');
	const interaction = (ms: number) => ({ name: 'click', t: 900, ms, delay: 3, processing: ms - 20, presentation: 17, target: 'button "Save"', fp, scripts: [{ url: `https://a.test${loc}`, fn: 'Ce', invoker: 'HTMLButtonElement.onclick', ms: ms - 25, phase: 'handler' }, { url: 7, phase: 'handler' }, { url: 'x.js', ms: 5, phase: 'elsewhere' }] });
	const v = parse_visit('/lab', { ...raw, vitals: { inp: 320 }, interaction: interaction(320) })!;
	expect(v.interaction?.scripts).toHaveLength(1);
	expect(v.interaction?.target).toBe('button "Save"');
	const lighter = parse_visit('/lab', { ...raw, vitals: { inp: 240 }, interaction: interaction(240) })!;
	expect(merge_visits(v, lighter).interaction?.ms).toBe(320);
	expect(merge_visits(lighter, v).interaction?.ms).toBe(320);
	// junk is dropped whole
	expect(parse_visit('/lab', { ...raw, interaction: { name: 'click' } })!.interaction).toBeUndefined();
	const f = browser_findings(browser_page_report(v, rows)).find((x) => x.code === 'slow-interaction');
	expect(f?.message).toContain('In the browser: INP is 320 ms');
	if (row) {
		expect(f?.message).toContain(`a click on button "Save" in ${row.name}`);
		// a same-origin event handler for a click in the island is the island's own
		expect(f?.message).toContain(`(mostly ${row.name}'s own click handler)`);
	}
});

test("a failed island's wake → failure span is kept (what held the islands below the fold); junk is not", () => {
	const fp = '0123456789abcdef';
	const v = parse_visit('/lab', { ...raw, regions: [{ fp, failed: 'planted', failed_span: [50, 740], top: 100, height: 20 }, { fp: 'fedcba9876543210', failed: 'x', failed_span: [9, 'a'], top: 0, height: 0 }] })!;
	expect(v.regions?.[0].failed_span).toEqual([50, 740]);
	expect(v.regions?.[1].failed_span).toBeUndefined();
	expect(parse_visit('/lab', { ...raw, regions: [{ fp, failed: 'x', failed_span: [800, 50], top: 0, height: 0 }] })!.regions?.[0].failed_span).toBeUndefined();
});

test('in-app navigations reach the report: parsed, merged once, out-of-order clocks dropped', () => {
	const n = { from: '/a', to: '/slow', type: 'link', t: 1000, fetched: 1820, styled: 1830, swapped: 1850 };
	const v = parse_visit('/lab', { ...raw, navs: [n, { ...n, to: '/bad', fetched: 900 }, { to: 7 }] })!;
	expect(v.navs).toHaveLength(1);
	expect(merge_visits(v, v).navs).toHaveLength(1);
	const f = browser_findings(browser_page_report(v, rows)).find((x) => x.code === 'slow-navigation');
	expect(f?.message).toContain('In the browser: The in-app navigation to /slow took 850 ms before the new page showed: 820 ms fetching the page from the server');
});

test('a preload downloaded again reaches the report, even on a page with no island', () => {
	const v = parse_visit('/lab', {
		...raw,
		islands: [],
		preload_misses: [{ url: 'https://a.test/dt-preload/data/planted', type: 'fetch', bytes: 28081, as: 'fetch', crossorigin: null }, { url: 7 }]
	})!;
	expect(v.preload_misses).toHaveLength(1);
	expect(merge_visits(v, { ...v, preload_misses: undefined }).preload_misses).toHaveLength(1);
	const f = browser_findings(browser_page_report(v, [])).find((x) => x.code === 'preload-unused');
	expect(f?.message).toContain('In the browser: planted (27.4 KB) was preloaded, then downloaded again');
});

test('a hole answered late: waited from the first paint, split by its server time', () => {
	const v = parse_visit('/lab', {
		...raw,
		paints: { fcp: 400 },
		holes_answered: [
			// fetch started before the paint: the fallback showed from the paint (1900 − 400)
			{ id: '8f81e0e4514e', start: 300, t: 1900, below_fold: false },
			{ id: '7c4afc210dc0', start: 300, t: 700, below_fold: false },
			{ id: 'aaaaaaaaaaaa', start: 3000, t: 6000, below_fold: true },
			{ id: 'bad', start: 900, t: 100 }
		]
	})!;
	expect(v.holes_answered?.map((h) => h.id)).toEqual(['8f81e0e4514e', '7c4afc210dc0', 'aaaaaaaaaaaa']);
	expect(merge_visits(v, v).holes_answered).toHaveLength(3);
	const names: Record<string, string> = { '8f81e0e4514e': 'SlowHole', '7c4afc210dc0': 'Greeting', aaaaaaaaaaaa: 'Footer' };
	const slow = (server?: number) =>
		browser_findings(browser_page_report(v, rows, undefined, undefined, (id) => names[id], () => server)).filter((x) => x.code === 'hole-slow');
	const bound = slow(1400);
	expect(bound).toHaveLength(1);
	expect(bound[0].message).toContain('SlowHole (1.5 s: 1.4 s the server render)');
	expect(bound[0].message).not.toContain('Greeting');
	expect(bound[0].message).not.toContain('Footer');
	expect(bound[0].fix).toMatch(/^The server render is the wait/);
	// the server answered in 90 ms: the wait was before or around the request
	expect(slow(90)[0].fix).toMatch(/^The server answered quickly/);
	// unknown server time: the general advice
	expect(slow(undefined)[0].message).toContain('SlowHole (1.5 s)');
	expect(slow(undefined)[0].fix).toContain('Holes section');
});

test('a server transform’s restore gone wrong rides the visit: a late host named in the report', () => {
	const v = parse_visit('/lab', {
		...raw,
		restores: [{ kind: 'late', host: 'demo-card', t: 21 }, { kind: 'odd', host: 'x' }, { kind: 'mismatch', host: 'x-nav', t: 30, diff: 'Svelte has <i>, the restored markup has nothing' }]
	})!;
	expect(v.restores).toHaveLength(2);
	expect(merge_visits(v, { ...v, restores: undefined }).restores).toHaveLength(2);
	const f = browser_findings(browser_page_report(v, []));
	expect(f.find((x) => x.code === 'restore-late')?.message).toContain('<demo-card> was upgraded by its component before ogygia restored it');
	expect(f.find((x) => x.code === 'restore-mismatch')?.message).toContain('Svelte has <i>');
});

test('holes in one batch request: a batched hole’s wait is the server’s, never the gate’s; a refused batch is named', () => {
	const part = (id: string, at: number) => ({ id, start: 100, t: at + 5, below_fold: false, left: 110, first: at, end: at, batch: 4 });
	const v = parse_visit('/lab', {
		...raw,
		paints: { fcp: 100 },
		holes_answered: [part('a1', 150), part('a2', 150), part('a3', 150), part('a4', 1310)],
		hole_batches: [{ sent: 4, delivered: 0, status: 405, ids: ['a1', 'a2', 'a3', 'a4'] }, { sent: 'x' }, { sent: 2, delivered: 3, status: 200, ids: [] }]
	})!;
	expect(v.holes_answered?.[3].batch).toBe(4);
	expect(v.hole_batches).toHaveLength(1);
	expect(merge_visits(v, { ...v, hole_batches: undefined }).hole_batches).toHaveLength(1);
	const f = browser_findings(browser_page_report(v, [], undefined, undefined, () => 'BatchHole'));
	const slow = f.find((x) => x.code === 'hole-slow')!;
	expect(slow.message).toContain('BatchHole (1.2 s: 1.2 s waiting on the server, its part of one request for 4 holes)');
	expect(slow.fix).not.toContain('hole requests at a time');
	const missed = f.find((x) => x.code === 'hole-batch-missed')!;
	expect(missed.message).toContain('The one request for 4 holes (BatchHole ×4) was answered 405');
});
