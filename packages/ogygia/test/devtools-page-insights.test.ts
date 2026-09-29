import { describe, it, expect } from 'vitest';
import { analyze_page, first_difference, rate, type PageInput, type RegionFact } from '../src/devtools/page-insights.js';
import { without_comments } from '../src/runtime/beacon.js';

const region = (fp: string, name: string, wake = 'load', extra: Partial<RegionFact> = {}): RegionFact => ({
	fp,
	name,
	kind: 'island',
	wake,
	hydrated: true,
	top: 100,
	height: 40,
	...extra
});

const page = (over: Partial<PageInput> = {}): PageInput => ({
	vitals: {},
	visit: { nav: { res_start: 50, dcl: 200, load: 300 }, paints: { fcp: 150, lcp: 180 }, resources: [], viewport: [1280, 800] },
	islands: [],
	firsts: [],
	shifts: [],
	longtasks: [],
	...over
});

const codes = (r: ReturnType<typeof analyze_page>) => r.findings.map((f) => f.code);

describe('without_comments', () => {
	it('drops every comment and keeps the rest', () => {
		expect(without_comments('<!--[--><p>a<!---->b</p><!--]-->')).toBe('<p>ab</p>');
		expect(without_comments('plain')).toBe('plain');
		expect(without_comments('a<!-- open')).toBe('a');
	});
});

describe('first_difference', () => {
	it('ignores re-anchored block markers and finds the visible change', () => {
		expect(first_difference('<!--[0--><p>x</p><!--]-->', '<!--[--><!--[0--><p>x</p><!--]--><!--]-->')).toBeNull();
		const d = first_difference('<p>rendered on the server</p>', '<p>rendered on the browser</p>');
		expect(d?.server).toContain('server');
		expect(d?.now).toContain('browser');
	});
});

describe('rate', () => {
	it('uses the web-vitals lines', () => {
		expect(rate('lcp', 2400)).toBe('good');
		expect(rate('lcp', 3000)).toBe('fair');
		expect(rate('lcp', 4000)).toBe('poor');
		expect(rate('cls', 0.05)).toBe('good');
		expect(rate('cls', 0.3)).toBe('poor');
	});
});

describe('analyze_page', () => {
	it('a healthy page has no findings', () => {
		const r = analyze_page(
			page({
				vitals: { ttfb: 100, fcp: 150, lcp: 180, cls: 0 },
				islands: [{ fp: 'a', t0: 60, loaded: 80, turn: 82, done: 86 }]
			}),
			[region('a', 'Healthy')],
			[],
			500
		);
		expect(r.findings).toEqual([]);
		expect(r.rows[0]).toMatchObject({ name: 'Healthy', load_ms: 20, queue_ms: 2, hydrate_ms: 4 });
	});

	it('pins each measured problem on its island', () => {
		const r = analyze_page(
			page({
				islands: [
					{ fp: 'clock', t0: 60, loaded: 80, turn: 80, done: 84, changed: true },
					{ fp: 'grow', t0: 60, loaded: 80, turn: 84, done: 90 },
					{ fp: 'heavy', t0: 60, loaded: 80, turn: 90, done: 230 },
					{ fp: 'late', t0: 400, loaded: 420, turn: 420, done: 430 }
				],
				shifts: [{ t: 100, value: 0.12, fp: 'grow' }],
				firsts: [{ fp: 'late', t: 380, type: 'pointer' }],
				snapshots: [{ fp: 'clock', ssr: '<!--[--><p>on the server</p><!--]-->', hydrated: '<!--[--><!--[--><p>on the browser</p><!--]--><!--]-->' }]
			}),
			[region('clock', 'Clock'), region('grow', 'Grower'), region('heavy', 'Heavy'), region('late', 'LateClick', 'visible', { top: 2000 })],
			[{ fp: 'broken', message: 'boom' }],
			500
		);
		const by = Object.fromEntries(r.findings.map((f) => [f.code, f]));
		expect(by['hydrate-failed'].severity).toBe('error');
		expect(by['markup-changed'].fps).toEqual(['clock']);
		expect(by['markup-changed'].message).toContain('"');
		expect(by['hydration-shift'].fps).toEqual(['grow']);
		expect(by['long-hydrate'].fps).toEqual(['heavy']);
		expect(by['early-click'].fps).toEqual(['late']);
		// errors first
		expect(r.findings[0].code).toBe('hydrate-failed');
	});

	it('an interaction island clicked before it woke is by design, not a lost click', () => {
		const r = analyze_page(
			page({ islands: [{ fp: 'ix', t0: 400, loaded: 420, done: 430 }], firsts: [{ fp: 'ix', t: 399, type: 'pointer' }] }),
			[region('ix', 'OnClick', 'interaction')],
			[],
			500
		);
		expect(codes(r)).not.toContain('early-click');
	});

	it('a click on an island that never woke counts too', () => {
		const r = analyze_page(page({ firsts: [{ fp: 'v', t: 250, type: 'pointer' }] }), [region('v', 'Sleepy', 'visible', { hydrated: false })], [], 500);
		expect(codes(r)).toContain('early-click');
	});

	it('eager islands below the fold, but not lazy ones', () => {
		const r = analyze_page(page(), [region('e', 'BelowEager', 'load', { top: 2000 }), region('l', 'BelowLazy', 'visible', { top: 2000 })], [], 500);
		const f = r.findings.find((x) => x.code === 'eager-offscreen');
		expect(f?.fps).toEqual(['e']);
	});

	it('an island’s code: a barrel imported whole, and one module most of its weight', () => {
		const r = analyze_page(
			page({
				island_code: [
					{ fp: 't', name: 'Toolbar', bytes: 52_000, top: [{ file: 'src/lib/Icons.svelte', bytes: 42_000 }, { file: 'src/lib/Toolbar.svelte', bytes: 1_700 }], barrels: [{ file: 'src/lib/ui/index.ts', fanout: 8 }] },
					// small, or spread out: nothing to say
					{ fp: 'h', name: 'Healthy', bytes: 1_400, top: [{ file: 'src/lib/Healthy.svelte', bytes: 1_400 }], barrels: [] },
					{ fp: 's', name: 'Spread', bytes: 60_000, top: [{ file: 'a.ts', bytes: 20_000 }, { file: 'b.ts', bytes: 20_000 }], barrels: [] }
				]
			}),
			[],
			[],
			2000
		);
		const f = r.findings.filter((x) => x.code.startsWith('island-'));
		expect(f.map((x) => `${x.code}:${x.fps.join()}`)).toEqual(['island-barrel:t', 'island-heavy-module:t']);
		expect(f[0].message).toContain('Toolbar still imports a barrel whole: src/lib/ui/index.ts, and the 8 modules behind it');
		expect(f[1].message).toContain("Icons.svelte is 81% of Toolbar's code (41 KB of 51 KB in dev)");
	});

	it('a hole whose answer never came is an error, with the cause and where to look', () => {
		const r = analyze_page(
			page({
				hole_failures: [
					{ name: 'Greeting', endpoint: './__ogygia__?id=a&sig=x', reason: 'redirected', final_url: 'http://x.test/account/', attempts: 1 },
					{ name: 'BrokenHole', endpoint: './__ogygia__?id=b&sig=y', reason: 'error', message: 'status 500', attempts: 3 }
				]
			}),
			[],
			[],
			2000
		);
		const f = r.findings.filter((x) => x.code === 'hole-failed');
		expect(f.map((x) => x.severity)).toEqual(['error', 'error']);
		expect(f[0].message).toContain('Greeting never got its answer: the request was redirected to /account/');
		expect(f[0].fix).toContain('Let that path through untouched');
		expect(f[1].message).toContain('BrokenHole never got its answer: the request failed 3 times (status 500)');
		expect(f[1].fix).toContain('./__ogygia__?id=b&sig=y');
		expect(codes(analyze_page(page(), [], [], 2000))).not.toContain('hole-failed');
	});

	it("an island whose own file was gone: the page outlived its build — woke on the current code, or stayed asleep", () => {
		const fb = (name: string, recovered: boolean) => ({ entry: `/_app/immutable/og-region.${name}.js`, src: `/_app/immutable/og-region.${name}.Ab12Cd34.js`, recovered, name: name === 'x' ? undefined : name });
		const woke = analyze_page(page({ visit: { entry_fallbacks: [fb('Probe', true), fb('Twin', true)] } }), [], [], 2000).findings.find((f) => f.code === 'island-file-gone')!;
		expect(woke.severity).toBe('warn');
		expect(woke.message).toContain('2 islands could not load their own files (og-region.Probe.Ab12Cd34.js and og-region.Twin.Ab12Cd34.js)');
		expect(woke.message).toContain('Probe and Twin woke on the current build');
		expect(woke.message).toContain('now come from different builds');
		expect(woke.fix).toContain("Keep the previous build's `_app/immutable/` files");
		const dead = analyze_page(page({ visit: { entry_fallbacks: [fb('Probe', false)] } }), [], [], 2000).findings.find((f) => f.code === 'island-file-gone')!;
		expect(dead.severity).toBe('error');
		expect(dead.message).toContain('Probe stayed asleep: its stable name failed too');
		// unnamed: its file stands in
		const unnamed = analyze_page(page({ visit: { entry_fallbacks: [fb('x', true)] } }), [], [], 2000).findings.find((f) => f.code === 'island-file-gone')!;
		expect(unnamed.message).toContain('og-region.x.js woke');
		expect(codes(analyze_page(page(), [], [], 2000))).not.toContain('island-file-gone');
	});

	it('the first paint, explained (slow-fcp): first byte, the HTML, what blocked it, the rest; the fix for the costliest', () => {
		const run = (over: object, fcp = 2400) => analyze_page(page({ vitals: { fcp }, ...over } as never), [], [], 9000).findings.find((f) => f.code === 'slow-fcp');
		const css = run({ visit: { ...page().visit!, nav: { res_start: 100, res_end: 150 }, paints: { fcp: 2400 }, resources: [{ url: 'https://a.test/slow.css?v=1', type: 'css', start: 160, end: 2360, blocking: true }, { url: 'https://a.test/quick.css', type: 'css', start: 160, end: 300, blocking: true }] } })!;
		expect(css.message).toBe('FCP is 2400 ms (needs work; good is ≤ 1800 ms). The first paint came after 100 ms until the HTML\'s first byte, 50 ms downloading the HTML, 2210 ms waiting for 2 files that block the paint (the slowest slow.css, 2200 ms), 40 ms more before it painted.');
		expect(css.fix).toMatch(/^The paint waits for slow.css/);
		// the main thread busy after everything arrived
		const busy = run({ visit: { ...page().visit!, nav: { res_start: 100, res_end: 150 }, paints: { fcp: 2400 }, resources: [] }, longtasks: [{ t: 300, ms: 1900 }] })!;
		expect(busy.message).toContain('2250 ms more before it painted (1900 ms of it long tasks)');
		expect(busy.fix).toMatch(/^Everything had arrived, but the main thread was busy/);
		// the first byte, and the HTML's download, the costliest
		expect(run({ visit: { ...page().visit!, nav: { res_start: 2000, res_end: 2050 }, paints: { fcp: 2400 }, resources: [] } })!.fix).toMatch(/^The server's first byte is most of it/);
		expect(run({ visit: { ...page().visit!, nav: { res_start: 100, res_end: 2100 }, paints: { fcp: 2400 }, resources: [] } })!.fix).toMatch(/^The HTML itself is slow to arrive/);
	});

	it('the first byte, explained (slow-ttfb): each step before it, the server’s Server-Timing, the fix for the costliest', () => {
		const run = (phases: object, server_timing?: object[]) => analyze_page(page({ vitals: { ttfb: 1500 }, visit: { ...page().visit!, nav: { res_start: 1500, phases, ...(server_timing ? { server_timing } : {}) } as never } }), [], [], 9000).findings.find((f) => f.code === 'slow-ttfb');
		const server = run({ dns: 12, connect: 20, tls: 30, wait: 1400 }, [{ name: 'render', ms: 250, desc: 'the page render' }, { name: 'db', ms: 900, desc: 'the database' }])!;
		expect(server.message).toBe("TTFB is 1500 ms (needs work; good is ≤ 800 ms). Before the page's first byte: 12 ms looking up the address, 50 ms connecting (30 ms of it TLS), 1400 ms waiting for the server's answer. The server's Server-Timing says: the database 900 ms and the page render 250 ms.");
		expect(server.fix).toMatch(/^The server's answer is the cost/);
		expect(run({ redirect: 1100, wait: 300 })!.fix).toMatch(/^The redirects are the cost/);
		expect(run({ worker: 900, wait: 400 })!.fix).toMatch(/^The service worker's start is the cost/);
		expect(run({ dns: 400, connect: 500, tls: 400, wait: 100 })!.fix).toMatch(/^Reaching the server is the cost/);
		// no steps recorded: the bare vital
		expect(codes(analyze_page(page({ vitals: { ttfb: 1500 } }), [], [], 9000))).toContain('vital-ttfb');
	});

	it('the worst shifts, explained (shift-cause): the burst, what moved, the cause just before, its fix', () => {
		const text = 'div "Paragraph 1"';
		const run = (over: Partial<PageInput>, regions: RegionFact[] = []) => analyze_page(page({ vitals: { cls: 0.2 }, ...over }), regions, [], 9000).findings.find((f) => f.code === 'shift-cause');
		// an image arrived with no size: the shift 40 ms later; an earlier small burst (3 s before) is not the worst
		const img = run({ shifts: [{ t: 500, value: 0.02, tag: 'h2' }, { t: 3540, value: 0.15, tag: text }, { t: 3900, value: 0.03, tag: text }], visit: { ...page().visit!, resources: [{ url: 'https://a.test/hero.png', type: 'img', start: 3000, end: 3500 }] } })!;
		expect(img.message).toBe('CLS is 0.2 (needs work; good is ≤ 0.1). The worst burst of shifts added 0.18, over 2 shifts in 360 ms: what moved was div "Paragraph 1" (0.18). It came right after the image hero.png arrived: it had no size set, so the page made room when it loaded.');
		expect(img.fix).toMatch(/^Set the image's `width` and `height`/);
		// a hole's answer swapped in (shown at 100, 380 ms wait: swapped at 480)
		const hole = run({ shifts: [{ t: 490, value: 0.2, tag: text }], hole_waits: [{ name: 'TallHole', wait_ms: 380, below_fold: false, shown_at: 100 }] })!;
		expect(hole.message).toContain("right after the hole TallHole's answer swapped in");
		expect(hole.fix).toMatch(/^Give the hole a fallback/);
		// an island hydrated: named on it, and the moved island's fp pinned
		const isl = run({ shifts: [{ t: 610, value: 0.2, fp: 'g' }], islands: [{ fp: 'g', t0: 100, loaded: 300, done: 600 }] }, [region('g', 'Grower')])!;
		expect(isl.message).toContain('what moved was Grower (0.2). It came right after Grower hydrated');
		expect(isl.fps).toEqual(['g']);
		// a web font; and nothing timed nearby: the unknown fix
		expect(run({ shifts: [{ t: 810, value: 0.2, tag: text }], visit: { ...page().visit!, resources: [{ url: 'https://a.test/f.woff2', type: 'font', start: 200, end: 800 }] } })!.fix).toMatch(/^Match the fallback font's metrics/);
		expect(run({ shifts: [{ t: 5000, value: 0.2, tag: text }] })!.fix).toMatch(/^Nothing the page timed explains it/);
		// a good CLS: nothing
		expect(codes(analyze_page(page({ vitals: { cls: 0.05 }, shifts: [{ t: 10, value: 0.05 }] }), [], [], 9000))).not.toContain('shift-cause');
	});

	it('the largest paint, explained (slow-lcp): the element, its island, its four parts, the fix for the most of it', () => {
		const hero = 'https://a.test/hero.png';
		const at = (paints: object, resources: object[], nav = { res_start: 120 }) => page({ vitals: { lcp: (paints as { lcp: number }).lcp }, visit: { ...page().visit!, nav, paints, resources: resources as never } });
		const run = (p: PageInput) => analyze_page(p, [region('h', 'Hero')], [], 9000).findings.find((f) => f.code === 'slow-lcp');
		// the download is the cost
		const load = run(at({ lcp: 3000, lcp_url: hero, lcp_tag: 'img', lcp_fp: 'h' }, [{ url: hero, type: 'img', start: 150, req_start: 160, end: 2950 }]))!;
		expect(load.severity).toBe('info');
		expect(load.message).toBe('LCP is 3000 ms (needs work; good is ≤ 2500 ms). The largest paint was the img (hero.png) in Hero: 120 ms until the HTML\'s first byte, 40 ms before the browser began fetching it, 2790 ms downloading it, 50 ms more before it painted.');
		expect(load.fix).toMatch(/^The file itself is slow to download/);
		expect(load.fps).toEqual(['h']);
		// found late
		expect(run(at({ lcp: 3000, lcp_url: hero, lcp_tag: 'img' }, [{ url: hero, type: 'img', start: 2600, end: 2900 }]))!.fix).toMatch(/^The browser found it late/);
		// ready but not painted
		expect(run(at({ lcp: 3000, lcp_url: hero, lcp_tag: 'img' }, [{ url: hero, type: 'img', start: 150, end: 400 }]))!.fix).toMatch(/^It was ready but did not paint/);
		// text: first byte, then render; the first byte the cost
		const text = run(at({ lcp: 3000, lcp_tag: 'h1' }, [], { res_start: 2800 }))!;
		expect(text.message).toContain('The largest paint was the h1: 2800 ms until the HTML\'s first byte, 200 ms more before it painted.');
		expect(text.fix).toMatch(/^The server's first byte is most of it/);
		// a good LCP: nothing; no paints: the bare vital
		expect(codes(analyze_page(at({ lcp: 900, lcp_tag: 'h1' }, []), [], [], 9000))).not.toContain('slow-lcp');
		expect(codes(analyze_page(page({ vitals: { lcp: 3000 }, visit: { ...page().visit!, nav: {} } }), [], [], 9000))).toContain('vital-lcp');
	});

	it('a slow in-app navigation: its split, the islands after it, the fix for the part that cost most; a quick one never', () => {
		const nav = (to: string, t: number, fetched: number, styled: number, swapped: number) => ({ from: '/a', to, type: 'link', t, fetched, styled, swapped });
		const r = analyze_page(
			page({
				visit: { ...page().visit!, navs: [nav('/slow', 1000, 1820, 1830, 1850), nav('/quick', 3000, 3050, 3052, 3060)] },
				islands: [{ fp: 'h', t0: 1855, loaded: 1860, turn: 1870, done: 1980 }]
			}),
			[region('h', 'Heavy')],
			[],
			5000
		);
		const f = r.findings.filter((x) => x.code === 'slow-navigation');
		expect(f).toHaveLength(1);
		expect(f[0].severity).toBe('info');
		expect(f[0].message).toBe('The in-app navigation to /slow took 850 ms before the new page showed: 820 ms fetching the page from the server, 10 ms loading its stylesheets, 20 ms swapping it in. Then its island woke over 130 ms (Heavy 110 ms to hydrate).');
		expect(f[0].fix).toMatch(/^The server's answer is the wait/);
		// the stylesheets, or the swap, the most of it: their fixes; past a second, a warning
		const styles = analyze_page(page({ visit: { ...page().visit!, navs: [nav('/css', 0, 100, 1300, 1320)] } }), [], [], 5000).findings.find((x) => x.code === 'slow-navigation')!;
		expect(styles.severity).toBe('warn');
		expect(styles.fix).toMatch(/^Its stylesheets were not in the browser yet/);
		const swap = analyze_page(page({ visit: { ...page().visit!, navs: [nav('/big', 0, 50, 60, 600)] } }), [], [], 5000).findings.find((x) => x.code === 'slow-navigation')!;
		expect(swap.fix).toMatch(/^The swap itself is heavy/);
		expect(swap.message).not.toContain('woke');
		expect(codes(analyze_page(page({ visit: { ...page().visit!, navs: [nav('/quick', 0, 200, 210, 250)] } }), [], [], 5000))).not.toContain('slow-navigation');
	});

	it('a slow navigation’s fetch, split by the page request’s timing: the server, a heavy page, a prefetch', () => {
		const one = (extra: object, fetched = 820) => analyze_page(page({ visit: { ...page().visit!, navs: [{ from: '/a', to: '/p', type: 'link', t: 0, fetched, styled: fetched + 5, swapped: fetched + 10, ...extra }] } }), [], [], 5000).findings.find((x) => x.code === 'slow-navigation')!;
		const server = one({ server: 800, download: 15, bytes: 2048 });
		expect(server.message).toContain('820 ms fetching the page from the server (800 ms waiting for its first byte, 15 ms downloading 2 KB)');
		expect(server.fix).toMatch(/^The server's answer is the wait/);
		// the download is most of it: the page itself is the cost
		const heavy = one({ server: 120, download: 690, bytes: 900 * 1024 });
		expect(heavy.fix).toMatch(/^The page itself is the wait: 900 KB of HTML took longer to download/);
		// prefetched on hover: the wait left after the click, and how much earlier the request began
		// the server side (the profiler's request log): where its time went, and the fix for the most of it
		const wait = one({ server: 800, download: 15, on_server: { ms: 804, cpu_ms: 30, net_ms: 0, net_count: 0 } });
		expect(wait.message).toContain('On the server that page took 804 ms: 30 ms running code, no outbound calls, and 774 ms waiting on something else.');
		expect(wait.fix).toMatch(/^The server waited on something that is neither its code nor an outbound call/);
		const calls = one({ server: 800, download: 15, on_server: { ms: 800, cpu_ms: 40, net_ms: 700, net_count: 3, inflight: 2 } });
		expect(calls.message).toContain('40 ms running code, 700 ms waiting on 3 outbound calls, and 60 ms waiting on something else (2 other requests were running: its CPU is shared).');
		expect(calls.fix).toMatch(/^The page's outbound calls are the wait/);
		expect(one({ server: 800, download: 15, on_server: { ms: 800, cpu_ms: 650, net_ms: 50, net_count: 1 } }).fix).toMatch(/^The server's own code is the wait/);
		const pre = one({ server: 800, download: 10, prefetched: true }, 430);
		expect(pre.message).toContain('430 ms still waiting for the page after the click (prefetched on hover 380 ms earlier: the server took 800 ms to answer)');
	});

	it('held for a failing first-screen island: not ogygia’s wait, and queued names what it was held for', () => {
		// BelowReady (below the fold) had its code at 60 and hydrated at 750; SlowFail (first screen)
		// was loading from 50 until it failed at 740 — the scheduler's viewport-first hold
		const base = page({ islands: [{ fp: 'b', t0: 50, loaded: 60, done: 752, turn: 750 }] });
		const regions = [region('b', 'BelowReady', 'load', { top: 3000 }), region('s', 'SlowFail', 'load', { top: 100, hydrated: false })];
		const held = analyze_page(base, regions, [{ fp: 's', message: 'planted', span: [50, 740] }], 3000);
		expect(codes(held)).not.toContain('held-idle');
		const q = held.findings.find((f) => f.code === 'queued')!;
		expect(q.message).toContain('BelowReady (690 ms) had its code but waited for its turn, held for SlowFail (680 ms, which then failed) on the first screen, still loading its code');
		expect(q.fix).toContain('(and fix the one that failed)');
		// without the failure's span (an older beacon), the wait reads as unexplained: the old answer
		expect(codes(analyze_page(base, regions, [{ fp: 's', message: 'planted' }], 3000))).toContain('held-idle');
		// a failing island BELOW the fold explains nothing about a below-the-fold wait
		const below = analyze_page(base, [regions[0], region('s', 'SlowFail', 'load', { top: 5000, hydrated: false })], [{ fp: 's', message: 'planted', span: [50, 740] }], 3000);
		expect(codes(below)).toContain('held-idle');
	});

	describe('the slowest interaction, explained (slow-interaction)', () => {
		const origin = 'https://a.test';
		const at = (over: Partial<PageInput['visit'] & object>) => ({ ...page().visit!, origin, ...over });
		const it_of = (over: object) => ({ name: 'click', t: 1000, ms: 300, delay: 5, processing: 270, presentation: 25, target: 'button "Save"', fp: 's', ...over });
		const find = (r: ReturnType<typeof analyze_page>) => r.findings.find((f) => f.code === 'slow-interaction');

		it("its own handler: the island clicked, the button, the phases, and the island's handler (Svelte's dispatcher never named)", () => {
			const r = analyze_page(
				page({ vitals: { inp: 300 }, visit: at({ interaction: it_of({ scripts: [{ url: `${origin}/_app/immutable/chunks/events-B1q.js`, fn: 'handle_event_propagation', invoker: 'DOCUMENT.onclick', ms: 268, phase: 'handler' }] }) }) }),
				[region('s', 'SlowSave')],
				[],
				3000
			);
			const f = find(r)!;
			// (the vital's rating sets the severity: 200–500 ms needs work)
			expect(f.severity).toBe('info');
			expect(f.message).toContain('INP is 300 ms (needs work; good is ≤ 200 ms). The slowest was a click on button "Save" in SlowSave: 5 ms before its handlers could run, 270 ms in its handlers (mostly SlowSave\'s own click handler), 25 ms to paint the next frame.');
			expect(f.message).not.toContain('handle_event_propagation');
			expect(f.fix).toMatch(/^The handler itself is the cost/);
			expect(f.fps).toEqual(['s']);
			// (in place of the bare vital, never beside it)
			expect(codes(r)).not.toContain('vital-inp');
		});

		it('another origin’s listener keeps its own name', () => {
			const f = find(analyze_page(page({ vitals: { inp: 300 }, visit: at({ interaction: it_of({ scripts: [{ url: 'https://tags.example/t.js', fn: 'track', invoker: 'DOCUMENT.onclick', ms: 250, phase: 'handler' }] }) }) }), [region('s', 'SlowSave')], [], 3000))!;
			expect(f.message).toContain("(mostly t.js's track (an event handler, 250 ms))");
		});

		it('it waited behind an island hydrating: named, and the fix is about waking later', () => {
			const f = find(
				analyze_page(
					page({ vitals: { inp: 320 }, islands: [{ fp: 'h', t0: 100, loaded: 900, done: 1300 }], visit: at({ interaction: it_of({ fp: 'q', target: 'button "Count"', delay: 290, processing: 10, presentation: 20 }) }) }),
					[region('q', 'QuickCount'), region('h', 'Heavy')],
					[],
					3000
				)
			)!;
			expect(f.message).toContain('in QuickCount: 290 ms before its handlers could run (Heavy was hydrating)');
			expect(f.fix).toMatch(/^The input waited for islands to hydrate/);
		});

		it('it waited behind a script in a long frame: the script, its function and what ran it', () => {
			const f = find(
				analyze_page(
					page({ vitals: { inp: 350 }, visit: at({ interaction: it_of({ fp: 'q', delay: 330, processing: 2, presentation: 18, scripts: [{ url: `${origin}/src/lib/BusyTimer.svelte?t=1`, fn: 'planted_busy_timer', invoker: 'TimerHandler:setTimeout', ms: 400, phase: 'delay' }] }) }) }),
					[region('q', 'QuickCount')],
					[],
					3000
				)
			)!;
			expect(f.message).toContain("(the main thread was running BusyTimer.svelte's planted_busy_timer (a timer, 400 ms))");
			expect(f.fix).toMatch(/^The input waited for other work on the main thread/);
		});

		it('the paint cost most: said so; a key press outside any island reads as such', () => {
			const f = find(analyze_page(page({ vitals: { inp: 260 }, visit: at({ interaction: it_of({ name: 'keydown', fp: undefined, target: 'input[name=q]', delay: 10, processing: 40, presentation: 210 }) }) }), [], [], 3000))!;
			expect(f.message).toContain('The slowest was a key press on input[name=q] outside any island: 10 ms before its handlers could run, 40 ms in its handlers, 210 ms to paint the next frame.');
			expect(f.fix).toMatch(/^Painting the result is the cost/);
			expect(f.fps).toEqual([]);
		});

		it('sampled: the handler’s function by name; its line only when the frames were source-mapped', () => {
			const fn = (name: string, file: string, line: number, kind: 'app' | 'svelte' | 'dependency' = 'app', self_ms = 250) => ({ name, file, line, kind, self_ms, total_ms: self_ms });
			const run = (cpu: object, over: object = {}) =>
				find(analyze_page({ ...page({ vitals: { inp: 300 }, visit: at({ interaction: it_of({ scripts: [{ url: `${origin}/_app/immutable/chunks/events-B1q.js`, fn: 'handle_event_propagation', invoker: 'DOCUMENT.onclick', ms: 268, phase: 'handler' }], ...over }) }) }), interaction_cpu: { t: 1000, wait: null, ...cpu } as never }, [region('s', 'SlowSave')], [], 3000))!.message;
			// mapped: the source's line; the app's own code over a Svelte internal above it
			expect(run({ mapped: true, handler: { ms: 260, top: [fn('set', 'svelte/internal/client/runtime.js', 90, 'svelte', 5), fn('save', 'src/lib/dtinp/SlowSave.svelte', 6)] } })).toContain("(mostly SlowSave's save (SlowSave.svelte:6), 250 ms sampled)");
			// unmapped (a dev server's served code): the function and its file, never a wrong line
			expect(run({ handler: { ms: 260, top: [fn('save', '/src/lib/dtinp/SlowSave.svelte', 18)] } })).toContain("(mostly SlowSave's save (SlowSave.svelte), 250 ms sampled)");
			// a build's minified frame in a chunk: never quoted; the frames' reading stands
			expect(run({ mapped: false, handler: { ms: 260, top: [fn('d', 'client/_app/immutable/og-region.0788ed45be5e.BwceK2yv.js', 1)] } })).toContain("(mostly SlowSave's own click handler)");
			// another interaction's trace (a different start): not this one's
			expect(run({ t: 5000, mapped: true, handler: { ms: 260, top: [fn('save', 'src/lib/dtinp/SlowSave.svelte', 6)] } })).not.toContain('sampled');
		});

		it('sampled: the wait names the function that held the thread, and what ran it', () => {
			const m = find(
				analyze_page(
					{
						...page({ vitals: { inp: 350 }, visit: at({ interaction: it_of({ fp: 'q', delay: 330, processing: 2, presentation: 18, scripts: [{ url: `${origin}/src/lib/BusyTimer.svelte`, fn: 'planted_busy_timer', invoker: 'TimerHandler:setTimeout', ms: 400, phase: 'delay' }] }) }) }),
						interaction_cpu: { t: 1000, mapped: true, wait: { ms: 330, top: [{ name: 'planted_busy_timer', file: 'src/lib/dtinp/BusyTimer.svelte', line: 9, kind: 'app', self_ms: 328, total_ms: 328 }] }, handler: null }
					},
					[region('q', 'QuickCount')],
					[],
					3000
				)
			)!.message;
			expect(m).toContain('330 ms before its handlers could run (the main thread was running planted_busy_timer (BusyTimer.svelte:9), 328 ms sampled, run by a timer)');
		});

		it('a good INP says nothing; an INP without the interaction keeps the bare vital', () => {
			expect(codes(analyze_page(page({ vitals: { inp: 120 }, visit: at({ interaction: it_of({ ms: 120 }) }) }), [], [], 3000))).not.toContain('slow-interaction');
			const bare = analyze_page(page({ vitals: { inp: 300 } }), [], [], 3000);
			expect(codes(bare)).toContain('vital-inp');
			expect(codes(bare)).not.toContain('slow-interaction');
		});
	});

	it('content-named files fetched again: revalidated (a round trip each) and downloaded on a reload, heaviest named first', () => {
		const re = (file: string, how: 'revalidated' | 'downloaded', bytes: number, ms: number, extra: object = {}) => ({ url: `https://a.test/_app/immutable/${file}`, how, bytes, ms, ...extra });
		const f = analyze_page(
			page({
				visit: {
					refetched: [
						// (Chrome reports a 304 with no body: bytes 0)
						re('og-region.a.Hh12.js', 'revalidated', 0, 40, { entry: '/_app/immutable/og-region.a.js', name: 'Probe' }),
						re('og-runtime.Kk34.js', 'revalidated', 0, 60, { runtime: true }),
						re('chunks/B1c2.js?v=1', 'revalidated', 3000, 30),
						re('og-region.b.Mm56.js', 'downloaded', 20480, 90, { name: 'Heavy' })
					]
				}
			}),
			[],
			[],
			2000
		).findings.find((x) => x.code === 'files-fetched-again')!;
		expect(f.severity).toBe('warn');
		expect(f.message).toContain('asked the server again for 4 files it already had');
		// slowest first; the requests overlap, so the slowest is quoted, never the sum
		expect(f.message).toContain('3 were revalidated with the server (the runtime, Probe and B1c2.js): a round trip each, the slowest 60 ms, for files that cannot change');
		expect(f.message).toContain('one came down again on this reload (Heavy, 20 KB) though the browser had just loaded it');
		expect(f.fix).toContain('max-age=31536000, immutable');
		const one = analyze_page(page({ visit: { refetched: [re('x.js', 'revalidated', 900, 12)] } }), [], [], 2000).findings.find((x) => x.code === 'files-fetched-again')!;
		expect(one.message).toContain('for a file it already had: one was revalidated with the server (x.js): a round trip each (12 ms), for a file that cannot change');
		expect(codes(analyze_page(page(), [], [], 2000))).not.toContain('files-fetched-again');
	});

	it('a preload the browser could not use, and paid for twice: named, with the fix for its kind', () => {
		const miss = (url: string, type: string, crossorigin: string | null, bytes = 20480) => ({ url, type, bytes, as: type === 'css' ? 'style' : type, crossorigin });
		const r = analyze_page(
			page({ visit: { preload_misses: [miss('https://a.test/fonts/inter.woff2', 'font', null, 40960), miss('https://a.test/api/data?x=1', 'fetch', 'use-credentials')] } }),
			[],
			[],
			2000
		);
		const f = r.findings.find((x) => x.code === 'preload-unused')!;
		expect(f.severity).toBe('warn');
		expect(f.message).toContain('inter.woff2 (40.0 KB) and data (20.0 KB) were preloaded, then downloaded again');
		expect(f.message).toContain('paid 60.0 KB twice');
		expect(f.fix).toContain('A font always loads in CORS mode: its preload needs `crossorigin`');
		expect(f.fix).toContain('Its `crossorigin="use-credentials"` does not match');
		const script = analyze_page(page({ visit: { preload_misses: [miss('https://a.test/app.js', 'script', null)] } }), [], [], 2000);
		expect(script.findings.find((x) => x.code === 'preload-unused')!.fix).toContain('modulepreload');
		expect(codes(analyze_page(page(), [], [], 2000))).not.toContain('preload-unused');
	});

	it('a hole whose fallback sat on the first screen long is named; a quick or scrolled-to one is not', () => {
		const r = analyze_page(
			page({
				hole_waits: [
					{ name: 'SlowHole', wait_ms: 1600, below_fold: false },
					{ name: 'Greeting', wait_ms: 300, below_fold: false },
					{ name: 'Footer', wait_ms: 4000, below_fold: true }
				]
			}),
			[],
			[],
			3000
		);
		const f = r.findings.filter((x) => x.code === 'hole-slow');
		expect(f).toHaveLength(1);
		expect(f[0].severity).toBe('warn');
		expect(f[0].message).toContain('SlowHole (1.6 s)');
		expect(f[0].message).not.toContain('Greeting');
		expect(f[0].message).not.toContain('Footer');
		// the gate: five holes, three requests at a time. The fourth and fifth left only as a slot
		// freed (900 ms after the paint), then waited 900 ms on the server
		const q = (n: number, left: number) => ({ name: `Q${n}`, below_fold: false, shown_at: 100, left_at: left, first_at: left + 880, end_at: left + 900, wait_ms: left + 910 - 100 });
		const gated = analyze_page(page({ hole_waits: [q(1, 100), q(2, 100), q(3, 100), q(4, 1000), q(5, 1000)] }), [], [], 3000).findings.find((x) => x.code === 'hole-slow')!;
		expect(gated.message).toContain('Q4 (1.8 s: 900 ms before its request left, 880 ms waiting on the server)');
		expect(gated.message).not.toContain('Q1');
		expect(gated.fix).toContain('runs 3 hole requests at a time, and 3 were ahead of it');
		// left late with nothing ahead: the page was busy, not the gate
		const busy = analyze_page(page({ hole_waits: [q(1, 1100)] }), [], [], 3000).findings.find((x) => x.code === 'hole-slow')!;
		expect(busy.fix).toMatch(/^Its request left late/);
		// left on time, the server took it all (the browser's first byte, no recorded render)
		const srv = analyze_page(page({ hole_waits: [{ name: 'S', below_fold: false, shown_at: 100, left_at: 110, first_at: 1500, end_at: 1510, wait_ms: 1420 }] }), [], [], 3000).findings.find((x) => x.code === 'hole-slow')!;
		expect(srv.message).toContain('S (1.4 s: 1.4 s waiting on the server)');
		expect(srv.fix).toMatch(/^The server is the wait/);
		// the server's render slots were full (its Server-Timing said): the queue, not the render
		const slot = analyze_page(
			page({ hole_waits: [{ name: 'Q5', below_fold: false, shown_at: 100, left_at: 110, first_at: 1900, end_at: 1910, wait_ms: 1820, server_queue_ms: 890, server_ms: 900 }] }),
			[],
			[],
			3000
		).findings.find((x) => x.code === 'hole-slow')!;
		expect(slot.message).toContain('Q5 (1.8 s: 890 ms waiting for a render slot on the server, 900 ms the server render)');
		expect(slot.fix).toMatch(/^It waited on the server for a render slot: a server process renders 4 holes at a time/);
		const mild = analyze_page(page({ hole_waits: [{ name: 'SlowHole', wait_ms: 1100, below_fold: false }] }), [], [], 3000);
		expect(mild.findings.find((x) => x.code === 'hole-slow')?.severity).toBe('info');
	});

	it('held with nothing ahead: the scheduler’s own wait is named, and only that', () => {
		// the round-46 shape: woken by a scroll long after load, code in hand, 70 ms with nothing ahead
		const idle = analyze_page(page({ islands: [{ fp: 'v', t0: 1000, loaded: 1000, turn: 1070, done: 1071 }] }), [region('v', 'Scrolled', 'visible')], [], 2000);
		const f = idle.findings.find((x) => x.code === 'held-idle');
		expect(f?.fps).toEqual(['v']);
		expect(f?.message).toContain('Scrolled had its code but waited 70 ms');
		// a queue: another island hydrated through the whole wait
		const queue = analyze_page(
			page({ islands: [{ fp: 'h', t0: 1000, loaded: 1000, turn: 1000, done: 1068 }, { fp: 'q', t0: 1000, loaded: 1000, turn: 1070, done: 1071 }] }),
			[region('h', 'Heavy'), region('q', 'Victim')],
			[],
			2000
		);
		expect(codes(queue)).not.toContain('held-idle');
		// the start gate: woken before DOMContentLoaded and the first paint (220 ms here)
		const gate = analyze_page(page({ islands: [{ fp: 'g', t0: 60, loaded: 80, turn: 215, done: 216 }] }), [region('g', 'Early')], [], 2000);
		expect(codes(gate)).not.toContain('held-idle');
		// held on purpose: below the fold, while a first-screen island still loads its code
		const held = analyze_page(
			page({ islands: [{ fp: 'f', t0: 990, loaded: 1075, turn: 1075, done: 1076 }, { fp: 'b', t0: 1000, loaded: 1000, turn: 1078, done: 1079 }] }),
			[region('f', 'Top'), region('b', 'Below', 'load', { top: 2000 })],
			[],
			2000
		);
		expect(codes(held)).not.toContain('held-idle');
		// under the threshold: the snapshot's normal first report
		const short = analyze_page(page({ islands: [{ fp: 'v', t0: 1000, loaded: 1000, turn: 1030, done: 1031 }] }), [region('v', 'Quick', 'visible')], [], 2000);
		expect(codes(short)).not.toContain('held-idle');
	});

	it('a queued island names the islands that ran ahead of it', () => {
		const r = analyze_page(
			page({
				islands: [
					{ fp: 'h', t0: 60, loaded: 80, turn: 80, done: 220 },
					{ fp: 'q', t0: 60, loaded: 80, turn: 230, done: 232 }
				]
			}),
			[region('h', 'Heavy'), region('q', 'Victim')],
			[],
			500
		);
		const f = r.findings.find((x) => x.code === 'queued');
		expect(f?.fps).toEqual(['q']);
		expect(f?.message).toContain('behind Heavy');
	});

	it('a later success clears nothing it should not: a wake-at-load island asleep 3 s after load', () => {
		const r = analyze_page(page(), [region('s', 'Asleep', 'load', { hydrated: false })], [], 3400);
		expect(codes(r)).toContain('never-woke');
		const early = analyze_page(page(), [region('s', 'Asleep', 'load', { hydrated: false })], [], 1000);
		expect(codes(early)).not.toContain('never-woke');
	});

	it('blocking files matter only when they held the paint back', () => {
		const small = Array.from({ length: 9 }, (_, i) => ({ url: `/a${i}.css`, type: 'css', start: 60, end: 64, blocking: true }));
		expect(codes(analyze_page(page({ visit: { ...page().visit!, resources: small } }), [], [], 500))).not.toContain('render-blocking');
		const slow = [{ url: '/big.css', type: 'css', start: 60, end: 400, blocking: true }];
		expect(codes(analyze_page(page({ visit: { ...page().visit!, paints: { fcp: 420 }, resources: slow } }), [], [], 500))).toContain('render-blocking');
	});

	it('the largest paint in an island that changed on hydration', () => {
		const r = analyze_page(
			page({
				visit: { ...page().visit!, paints: { fcp: 150, lcp: 180, lcp_fp: 'hero', lcp_tag: 'h1' } },
				islands: [{ fp: 'hero', t0: 60, loaded: 80, done: 90, changed: true }]
			}),
			[region('hero', 'Hero')],
			[],
			500
		);
		expect(codes(r)).toContain('lcp-repaint');
	});

	it('long tasks outside hydration are the page scripts', () => {
		const r = analyze_page(
			page({ islands: [{ fp: 'a', t0: 60, loaded: 80, done: 90 }], longtasks: [{ t: 700, ms: 220 }] }),
			[region('a', 'A')],
			[],
			1500
		);
		expect(codes(r)).toContain('long-tasks');
		expect(r.longtask_ms).toBe(220);
	});
});
