import { describe, it, expect } from 'vitest';
import { analyze_page, boolean_attr_at, encoding_only, first_difference, lcp_font, lcp_rivals, rate, vital_parts, type PageInput, type RegionFact } from '../src/devtools/page-insights.js';
import { without_comments, without_runtime_marks } from '../src/runtime/beacon.js';

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
	it("ignores the runtime's own marks on a nested island, and finds the real change past them", () => {
		const ssr = '<ogygia-region entry="/a.js"><button>bump</button></ogygia-region>';
		expect(first_difference(ssr, '<ogygia-region entry="/a.js" data-nested="" data-hydrated=""><button>bump</button></ogygia-region>')).toBeNull();
		const d = first_difference(ssr, '<ogygia-region entry="/a.js" data-nested=""><button>bumped</button></ogygia-region>');
		expect(d?.now).toContain('bumped');
		expect(d?.now).not.toContain('data-nested');
	});
});

describe('without_runtime_marks', () => {
	it('drops only the empty marks the runtime sets', () => {
		expect(without_runtime_marks('<x data-nested="" data-hydrated="" data-og-kept="" data-revalidated="">')).toBe('<x>');
		// (an app's own attribute that looks alike keeps its value)
		expect(without_runtime_marks('<x data-nested="yes" data-hydrated-at="">')).toBe('<x data-nested="yes" data-hydrated-at="">');
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

describe('text kept invisible by its font', () => {
	it('a font-display auto face whose file landed after the first paint; swap, or early, quiet', () => {
		const at = (display: string, end: number) =>
			analyze_page(
				page({
					visit: {
						nav: { res_start: 5 },
						paints: { fcp: 100 },
						viewport: [1280, 800],
						resources: [{ url: 'http://x/f/slow.woff2', type: 'font', start: 20, end }],
						font_faces: [{ family: 'SlowFace', display, urls: ['http://x/f/slow.woff2'] }]
					}
				}),
				[],
				[],
				3000
			).findings.find((f) => f.code === 'font-invisible');
		expect(at('auto', 1600)?.message).toContain("Text in 'SlowFace' (slow.woff2, 1500 ms after the first paint) stayed invisible");
		expect(at('block', 1600)).toBeDefined();
		expect(at('swap', 1600)).toBeUndefined();
		// arrived before the first paint: nothing was hidden on screen
		expect(at('auto', 90)).toBeUndefined();
	});
});

describe('scrolling stalled', () => {
	const at = (frames: NonNullable<NonNullable<PageInput['visit']>['scroll_jank']>) =>
		analyze_page(page({ visit: { nav: { res_start: 5 }, paints: {}, viewport: [1400, 900], scroll_jank: frames } }), [], [], 3000).findings.find((f) => f.code === 'scroll-jank');
	const heavy = { url: 'http://x/src/lib/Janky.svelte?t=1', fn: 'heavy_scroll_work', invoker: 'DOMWindow.onscroll', ms: 120 };
	it('names the frames, the worst, and the script that held them most with what ran it', () => {
		expect(at([{ start: 1200, ms: 128, scripts: [heavy] }, { start: 1400, ms: 124, scripts: [heavy, { url: 'http://x/a.js', fn: '', invoker: 'TimerHandler', ms: 2 }] }])?.message).toBe(
			"Scrolling stalled: 2 frames took up to 128 ms (252 ms in all) while the page scrolled, mostly heavy_scroll_work (Janky.svelte), run by DOMWindow.onscroll (240 ms): the page could not follow the visitor's scroll."
		);
	});
	it('a frame or two of 60 ms: quiet', () => {
		expect(at([{ start: 1200, ms: 60, scripts: [heavy] }, { start: 1400, ms: 62, scripts: [] }])).toBeUndefined();
	});
});

describe('images the browser could hold no room for', () => {
	const at = (cls: number | undefined) =>
		analyze_page(page({ vitals: cls === undefined ? {} : { cls }, visit: { nav: { res_start: 5 }, paints: {}, viewport: [1400, 900], images_unsized: ['http://x/dt-lcp/hero.svg?quick'] } }), [], [], 3000).findings.find((f) => f.code === 'img-unsized');
	it('a note; a warning once the page moved', () => {
		expect(at(undefined)?.severity).toBe('info');
		expect(at(undefined)?.message).toBe('hero.svg has no size the browser knows before the file comes (no width and height, no CSS aspect-ratio), so what is below moves when it arrives (unless CSS sets its height).');
		expect(at(0.13)?.severity).toBe('warn');
		expect(at(0.13)?.message).toContain('— and this page moved (CLS 0.13)');
	});
});

describe('kept out of the back/forward cache', () => {
	const at = (bfcache: PageInput['bfcache']) => analyze_page(page({ ...(bfcache ? { bfcache } : {}) }), [], [], 3000).findings.find((f) => f.code === 'bfcache-blocked');
	it("names who adds an 'unload' listener, and the browser's reasons when Back did not restore", () => {
		expect(at({ unload: ['Saver'] })?.message).toBe(
			"Saver adds an 'unload' listener: the browser keeps no page with one in its back/forward cache, so Back and Forward load this page from the server again instead of showing it at once."
		);
		expect(at({ unload: [], not_restored: ['main-resource-has-cache-control-no-store'] })?.message).toBe(
			"This load came from Back or Forward, and the browser did not restore the page from its back/forward cache: it loaded from the server again. The browser's reasons for this load: main-resource-has-cache-control-no-store."
		);
		expect(at(undefined)).toBeUndefined();
	});
	it("the profiler's run saw the page answer no-store: said, with or without an unload listener", () => {
		const brief = { ago_min: 1, render_ms: 4, top: null, calls: 0, calls_ms: 0, no_store: 'no-store' };
		const only = analyze_page(page({ server_profile: brief }), [], [], 3000).findings.find((f) => f.code === 'bfcache-blocked');
		expect(only?.message.startsWith("The page answers with Cache-Control: no-store (the profiler's last run of it saw so)")).toBe(true);
		const both = analyze_page(page({ server_profile: brief, bfcache: { unload: ['Saver'] } }), [], [], 3000).findings.find((f) => f.code === 'bfcache-blocked');
		expect(both?.message).toContain('It also answers with Cache-Control: no-store, which keeps it out too.');
	});
});

describe('listeners that hold scrolling', () => {
	it('names each with its owner, event and element; passive: false said', () => {
		const f = analyze_page(
			page({
				scroll_blockers: [
					{ owner: 'Wheelie', type: 'wheel', on: 'div.wheelie', forced: false },
					{ owner: 'widget.js', type: 'touchmove', on: 'window', forced: true }
				]
			}),
			[],
			[],
			3000
		).findings.find((x) => x.code === 'scroll-blocking');
		expect(f?.message.startsWith("Wheelie's 'wheel' listener on div.wheelie and widget.js's 'touchmove' listener on window (passive: false) hold scrolling")).toBe(true);
		expect(f?.fix).toContain('{ passive: true }');
	});
});

describe("a shift the dev server's CSS made is not the island's waking", () => {
	it('dev: a shift right after a component CSS module landed is left out; a build counts it', () => {
		const at = (dev: boolean) =>
			analyze_page(
				page({
					...(dev ? { dev: true } : {}),
					visit: { nav: { res_start: 5 }, paints: {}, viewport: [1400, 900], resources: [{ url: 'http://x/src/lib/CtaCounter.svelte?svelte&type=style&lang.css', type: 'other', start: 30, end: 42 }] },
					islands: [{ fp: 'aaaa000011112222', entry: '/src/lib/CtaCounter.svelte', t0: 20, loaded: 40, turn: 45, done: 60 }],
					shifts: [{ t: 47, value: 0.12, fp: 'aaaa000011112222' }]
				}),
				[{ fp: 'aaaa000011112222', name: 'CtaCounter', kind: 'island' } as RegionFact],
				[],
				3000
			).findings.find((f) => f.code === 'hydration-shift');
		expect(at(true)).toBeUndefined();
		expect(at(false)?.message).toContain('Hydrating CtaCounter (CLS 0.12) moved the layout');
	});
	it("dev: another island's own sheet, landing below the moved island, did not push it", () => {
		const at = (bar_top: number) =>
			analyze_page(
				page({
					dev: true,
					visit: { nav: { res_start: 5 }, paints: {}, viewport: [1400, 900], resources: [{ url: 'http://x/src/lib/PhoneBar.svelte?svelte&type=style&lang.css', type: 'other', start: 30, end: 42 }] },
					islands: [{ fp: 'aaaa000011112222', entry: '/src/lib/Grower.svelte', t0: 20, loaded: 40, turn: 45, done: 60 }],
					shifts: [{ t: 200, value: 0.07, fp: 'aaaa000011112222' }]
				}),
				[
					{ fp: 'aaaa000011112222', name: 'Grower', kind: 'island', wake: 'load', hydrated: true, top: 100 },
					{ fp: 'bbbb000011112222', name: 'PhoneBar', kind: 'island', wake: 'load', hydrated: true, top: bar_top, hidden: true }
				],
				[],
				3000
			).findings.find((f) => f.code === 'hydration-shift');
		expect(at(2400)?.message).toContain('Hydrating Grower (CLS 0.07) moved the layout');
		// above it, its sheet could have pushed it: left out
		expect(at(20)).toBeUndefined();
	});
});

describe("an island's effects are its own work", () => {
	it('effects run after hydrate() returns: the long task is the island\'s, the next island waited behind it', () => {
		const r = analyze_page(
			page({
				visit: { nav: { res_start: 5 }, paints: {}, viewport: [1400, 900] },
				islands: [
					{ fp: 'aaaa000011112222', entry: '/src/lib/Thrash.svelte', t0: 80, loaded: 90, turn: 95, done: 100, fx: 410 },
					{ fp: 'bbbb000011112222', entry: '/src/lib/Batched.svelte', t0: 80, loaded: 100, turn: 410, done: 420 }
				],
				longtasks: [{ t: 95, ms: 315 }]
			}),
			[
				{ fp: 'aaaa000011112222', name: 'Thrash', kind: 'island', wake: 'load' } as RegionFact,
				{ fp: 'bbbb000011112222', name: 'Batched', kind: 'island', wake: 'load' } as RegionFact
			],
			[],
			3000
		);
		const codes = r.findings.map((f) => f.code);
		expect(codes).not.toContain('long-tasks');
		expect(codes).not.toContain('held-idle');
		expect(r.findings.find((f) => f.code === 'queued')?.message).toContain('behind Thrash');
	});
});

describe('forced layout', () => {
	const run = (forced: NonNullable<NonNullable<PageInput['visit']>['forced_layout']>) =>
		analyze_page(
			page({
				visit: { nav: { res_start: 5 }, paints: {}, viewport: [1400, 900], forced_layout: forced },
				islands: [
					{ fp: 'aaaa000011112222', entry: '/src/lib/Thrash.svelte', t0: 80, loaded: 90, turn: 95, done: 410 },
					{ fp: 'bbbb000011112222', entry: '/src/lib/Batched.svelte', t0: 80, loaded: 90, turn: 410, done: 420 }
				]
			}),
			[
				{ fp: 'aaaa000011112222', name: 'Thrash', kind: 'island' } as RegionFact,
				{ fp: 'bbbb000011112222', name: 'Batched', kind: 'island' } as RegionFact
			],
			[],
			3000
		).findings.find((f) => f.code === 'forced-layout');
	it('the runtime task is put on the island whose hydration overlaps it most; a page script by its file', () => {
		const f = run([
			{ start: 81, end: 409, ms: 317, url: 'http://x/runtime/schedule.ts', fn: '' },
			{ start: 900, end: 960, ms: 40, url: 'http://x/assets/widget.js?v=3', fn: 'measure' }
		]);
		expect(f?.message.startsWith('Thrash while it hydrated (317 ms) and widget.js (measure) (40 ms) made the browser recalculate style and layout')).toBe(true);
		expect(f?.fps).toEqual(['aaaa000011112222']);
	});
	it('under 30 ms for each: quiet', () => {
		expect(run([{ start: 411, end: 419, ms: 8, url: 'http://x/runtime/schedule.ts', fn: '' }])).toBeUndefined();
	});
	it("the CPU trace's place, the island named once when the time is its own code", () => {
		const cpu = {
			window_ms: 1000,
			busy_ms: 330,
			by_kind: [],
			fns: [],
			files: [],
			islands: { aaaa000011112222: { ms: 320, top: [{ name: 'Thrash', file: 'src/lib/Thrash.svelte', line: 5, kind: 'app', self_ms: 307, total_ms: 316 }] } },
			outside: { ms: 0, top: [] },
			interval_ms: 10
		} as never;
		const f = analyze_page(
			page({
				visit: { nav: { res_start: 5 }, paints: {}, viewport: [1400, 900], forced_layout: [{ start: 81, end: 409, ms: 317, url: 'http://x/runtime/schedule.ts', fn: '' }] },
				islands: [{ fp: 'aaaa000011112222', entry: '/src/lib/Thrash.svelte', t0: 80, loaded: 90, turn: 95, done: 410 }]
			}),
			[{ fp: 'aaaa000011112222', name: 'Thrash', kind: 'island' } as RegionFact],
			[],
			3000,
			cpu
		).findings.find((x) => x.code === 'forced-layout');
		expect(f?.message.startsWith('Thrash while it hydrated (317 ms; mostly its own code (Thrash.svelte:5)) made')).toBe(true);
	});
});

describe('images far below the first screen that loaded at start', () => {
	const at = (images: NonNullable<NonNullable<PageInput['visit']>['images_eager_below']>) =>
		analyze_page(page({ visit: { nav: { res_start: 5 }, paints: {}, viewport: [1400, 900], images_eager_below: images } }), [{ fp: 'ffff000011112222', name: 'Gallery', kind: 'island' } as RegionFact], [], 3000).findings.find((f) => f.code === 'images-eager-below');
	it('names each file once (×N for copies), how far down, the island; biggest first', () => {
		const f = at([
			{ url: 'http://x/i/thumb.jpg', top: 2700, bytes: 30_000, fp: 'ffff000011112222' },
			{ url: 'http://x/i/right.png?a', top: 3420, bytes: 360_000 },
			{ url: 'http://x/i/right.png?b', top: 3420, bytes: 360_000 }
		]);
		expect(f?.message).toBe(
			"right.png ×2 (703 KB, 3.8 screens down) and thumb.jpg (29 KB, 3.0 screens down, in Gallery) load at start though far below the first screen: 732 KB that competed with the first screen's files for the network."
		);
		expect(f?.fps).toEqual(['ffff000011112222']);
	});
	it('under 100 KB in all: quiet', () => {
		expect(at([{ url: 'http://x/i/a.jpg', top: 3000, bytes: 60_000 }])).toBeUndefined();
	});
	it('the ones whose download overlapped a slow hero are named in its LCP split', () => {
		const hero = 'http://x/hero.jpg';
		const visit: PageInput['visit'] = {
			nav: { res_start: 20 },
			paints: { fcp: 100, lcp: 2700, lcp_url: hero, lcp_tag: 'img' },
			viewport: [1400, 900],
			resources: [
				{ url: hero, type: 'img', start: 40, req_start: 45, end: 2650 },
				{ url: 'http://x/i/right.png?a', type: 'img', start: 50, end: 900 },
				{ url: 'http://x/i/late.png', type: 'img', start: 2800, end: 3000 }
			],
			images_eager_below: [
				{ url: 'http://x/i/right.png?a', top: 3400, bytes: 360_000 },
				{ url: 'http://x/i/late.png', top: 3400, bytes: 200_000 }
			]
		};
		expect(lcp_rivals(visit)).toEqual({ bytes: 360_000, files: ['right.png'] });
		const f = analyze_page(page({ visit, vitals: { lcp: 2700 } }), [], [], 5000).findings.find((x) => x.code === 'slow-lcp');
		expect(f?.message).toContain('Beside it, 352 KB of images far below the first screen downloaded (right.png).');
		expect(f?.fix).toContain('`loading="lazy"`');
	});
});

describe('preloaded, never used', () => {
	it('names each file, what it is, and why nothing used it', () => {
		const f = analyze_page(
			page({
				visit: {
					nav: { res_start: 5 },
					paints: {},
					viewport: [1280, 800],
					preloads_unused: [
						{ url: 'http://x/dt-img/right.png', as: 'image', bytes: 360_473 },
						{ url: 'http://x/dt-font/orphan.woff2?v=2', as: 'font', bytes: 2048 }
					]
				}
			}),
			[],
			[],
			8000
		).findings.find((x) => x.code === 'preload-never-used');
		expect(f?.message).toBe(
			'right.png (image, 352.0 KB: no image on the page shows it) and orphan.woff2 (font, 2.0 KB: no @font-face names it) were preloaded, but nothing on the page used them 3 s after load: the bytes competed with the files the first screen needed.'
		);
	});
});

describe('text sent uncompressed', () => {
	const at = (visit: Partial<NonNullable<PageInput['visit']>>, dev = false) =>
		analyze_page(page({ ...(dev ? { dev: true } : {}), visit: { nav: { res_start: 5 }, paints: {}, viewport: [1280, 800], ...visit } }), [], [], 3000).findings.find((f) => f.code === 'uncompressed');
	const files = [
		{ url: 'http://x/dt-raw/blob.js', type: 'script', bytes: 120_447 },
		{ url: 'http://x/dt-raw/table.json?v=1', type: 'fetch', bytes: 35_281 }
	];
	it('names each file, its kind and size; a warning past 100 KB', () => {
		const f = at({ uncompressed: files });
		expect(f?.severity).toBe('warn');
		expect(f?.message).toContain('blob.js (script, 117.6 KB) and table.json (fetch, 34.5 KB) came down uncompressed: 152.1 KB');
	});
	it("the page's own HTML, first", () => {
		const f = at({ nav: { res_start: 5, size: 40_000, raw: true } });
		expect(f?.severity).toBe('info');
		expect(f?.message).toMatch(/^the page's HTML \(39\.1 KB\) came down uncompressed/);
	});
	it('under 20 KB in all, or on the dev server: nothing', () => {
		expect(at({ uncompressed: [{ url: 'http://x/a.js', type: 'script', bytes: 9000 }] })).toBeUndefined();
		expect(at({ uncompressed: files }, true)).toBeUndefined();
	});
});

describe('an island that threw its server HTML away (recovered)', () => {
	const at = (healed?: true) =>
		analyze_page(page({ islands: [{ fp: 's', t0: 10, loaded: 20, done: 30, recovered: true, ...(healed ? { healed } : {}) }] }), [region('s', 'Sidebar')], [], 500).findings.find((f) => f.code === 'recovered')!;
	it('no browser script edited it before waking: a rewrite on the way or the component itself, and where to look', () => {
		const f = at();
		expect(f.message).toContain('No script in the browser edited it before waking: either its HTML was rewritten on the way from the server, or the component itself drew a different tree in the browser.');
		expect(f.fix).toContain('transformPageChunk');
		expect(f.fix).toContain('an `await` at the top of its script');
	});
	it('with the dev server reading its sources: the likeliest line, and the fix for it', () => {
		const f = analyze_page(
			page({
				islands: [{ fp: 's', t0: 10, loaded: 20, done: 30, recovered: true }],
				island_code: [{ fp: 's', name: 'Sidebar', bytes: 1000, top: [], barrels: [], hazards: [{ file: 'src/lib/Sidebar.svelte', line: 39, code: 'const fetched = await site.nav();', kind: 'await' }] }]
			}),
			[region('s', 'Sidebar')],
			[],
			500
		).findings.find((x) => x.code === 'recovered')!;
		expect(f.message).toContain('In its own code, the likeliest: Sidebar.svelte:39 (`const fetched = await site.nav();`) awaits at the top of its script');
		expect(f.fix).toMatch(/^Give both sides the same answer/);
	});
	it('a script edited it first (the runtime healed it): the edit is the cause', () => {
		const f = at(true);
		expect(f.message).toContain('Something changed the markup between the server and hydration.');
		expect(f.fix).toMatch(/^Look for a script that edits the page/);
	});
	it('the same markup came back: no line of its blamed, its own finding; one that drew another tree keeps the line', () => {
		const hazard = (file: string) => [{ file, line: 4, code: "const server = typeof window === 'undefined';", kind: 'browser' as const, reads: 'typeof window' }];
		const fs = analyze_page(
			page({
				islands: [
					// compared (ssr_bytes) and unchanged: the same tree
					{ fp: 's', t0: 10, loaded: 20, done: 30, recovered: true, ssr_bytes: 120 },
					{ fp: 'd', t0: 10, loaded: 20, done: 30, recovered: true, changed: true, ssr_bytes: 90 }
				],
				island_code: [
					{ fp: 's', name: 'SameTree', bytes: 1000, top: [], barrels: [], hazards: hazard('src/lib/SameTree.svelte') },
					{ fp: 'd', name: 'DiffTree', bytes: 1000, top: [], barrels: [], hazards: hazard('src/lib/DiffTree.svelte') }
				]
			}),
			[region('s', 'SameTree'), region('d', 'DiffTree')],
			[],
			500
		).findings.filter((x) => x.code === 'recovered');
		expect(fs).toHaveLength(2);
		const same = fs.find((f) => f.fps?.[0] === 's')!;
		expect(same.message).toContain('SameTree threw away the server HTML and rendered again in the browser (a flash and a double render) — and drew the same markup it threw away');
		expect(same.message).not.toContain('SameTree.svelte:4');
		expect(same.fix).toMatch(/^Report it to ogygia/);
		const diff = fs.find((f) => f.fps?.[0] === 'd')!;
		expect(diff.message).toContain('DiffTree.svelte:4');
		// never compared (no server copy): not called the same
		expect(at().message).not.toContain('the same markup');
	});
});

describe('a page of many elements', () => {
	type Dom = NonNullable<NonNullable<PageInput['visit']>['dom']>;
	const at = (dom: Dom, regions: RegionFact[] = []) =>
		analyze_page(page({ visit: { nav: { res_start: 5 }, paints: {}, viewport: [1280, 800], dom } }), regions, [], 3000).findings.find((f) => f.code === 'dom-large');
	const base: Dom = { nodes: 3634, depth: 7, deepest: 'b', widest: { at: 'ul.dense', children: 1200 }, islands: [{ fp: 'ffff000011112222', nodes: 3601 }] };
	it('names the island holding most of them, linked', () => {
		const f = at(base, [{ fp: 'ffff000011112222', name: 'DenseList', kind: 'island' } as RegionFact]);
		expect(f?.message).toBe(
			'The page has 3,634 elements (nested 7 deep; the most children, 1,200, under ul.dense), 3,601 of them inside DenseList: an island hydrates over every element of its own, so it pays for all of them as it wakes.'
		);
		expect(f?.fps).toEqual(['ffff000011112222']);
	});
	it('an island with a small share is not blamed; a past-60,000 count says only the count; under 1,500 quiet', () => {
		expect(at({ ...base, islands: [{ fp: 'a', nodes: 200 }] })?.fps).toEqual([]);
		expect(at({ ...base, nodes: 70_000, depth: 0, islands: [] })?.message).toBe('The page has 70,000 elements: every element costs memory and style and layout work on each change.');
		expect(at({ ...base, nodes: 1200 })).toBeUndefined();
	});
});

describe('images sent far bigger than shown', () => {
	const at = (images: NonNullable<NonNullable<PageInput['visit']>['images_oversized']>) =>
		analyze_page(page({ visit: { nav: { res_start: 5 }, paints: {}, viewport: [1280, 800], images_oversized: images } }), [], [], 3000).findings.find((f) => f.code === 'image-oversized');
	it('names the image, its sizes and the bytes nobody sees; the biggest waste first', () => {
		const f = at([
			{ url: 'http://x/a/small-waste.jpg', natural: [800, 600], shown: [200, 150], dpr: 1, bytes: 60_000 },
			{ url: 'http://x/a/big.png?v=1', natural: [2000, 1333], shown: [300, 200], dpr: 2, bytes: 352_000 }
		]);
		expect(f?.message).toBe(
			'big.png (2000×1333, shown at 300×200 on a 2× screen) and small-waste.jpg (800×600, shown at 200×150) are sent far bigger than shown: about 368 KB of 402 KB is pixels nobody sees.'
		);
	});
	it('a small total waste is quiet', () => {
		expect(at([{ url: 'http://x/a/b.jpg', natural: [800, 600], shown: [400, 300], dpr: 1, bytes: 52_000 }])).toBeUndefined();
	});
});

describe('the font the largest paint waited for', () => {
	const visit = (display: string, lcp: number, lcp_url?: string): PageInput['visit'] => ({
		nav: { res_start: 50 },
		paints: { fcp: 100, lcp, ...(lcp_url ? { lcp_url } : {}) },
		viewport: [1280, 800],
		resources: [{ url: 'http://x/f/slow.woff2', type: 'font', start: 60, end: 2900 }],
		font_faces: [{ family: 'SlowFace', display, urls: ['http://x/f/slow.woff2'] }]
	});
	it('a text paint right after a hidden face landed names it; swap, an image paint, or a paint long after, does not', () => {
		expect(lcp_font(visit('auto', 2950))).toEqual({ family: 'SlowFace', file: 'slow.woff2', end: 2900 });
		expect(lcp_font(visit('swap', 2950))).toBeNull();
		expect(lcp_font(visit('auto', 2950, 'http://x/hero.jpg'))).toBeNull();
		expect(lcp_font(visit('auto', 3500))).toBeNull();
		// the paint read a little before the file's end (two clocks): still the font's, capped at the paint
		expect(lcp_font(visit('auto', 2850))?.end).toBe(2850);
		expect(lcp_font(visit('auto', 2700))).toBeNull();
	});
	it("the LCP's split and parts carry the font wait", () => {
		const p = page({ visit: visit('auto', 2950), vitals: { lcp: 2950 } });
		expect(vital_parts(p, 'lcp')?.map((x) => [x.key, Math.round(x.ms)])).toEqual([
			['ttfb', 50],
			['font', 2850],
			['render', 50]
		]);
		const f = analyze_page(p, [], [], 4000).findings.find((x) => x.code === 'slow-lcp');
		expect(f?.message).toContain("2850 ms waiting for its font 'SlowFace' (slow.woff2), the text invisible until it came");
		expect(f?.fix).toContain('font-display: swap');
	});
});

describe('the largest paint marked lazy', () => {
	it('named, with its file and island; a largest paint without it quiet', () => {
		const at = (lazy: boolean) =>
			analyze_page(
				page({ visit: { nav: { res_start: 5 }, paints: { fcp: 20, lcp: 300, lcp_tag: 'img', lcp_url: 'http://x/hero.jpg?w=2', lcp_fp: 'hero', ...(lazy ? { lcp_lazy: true as const } : {}) }, resources: [], viewport: [1280, 800] } }),
				[region('hero', 'Hero')],
				[],
				500
			).findings.find((f) => f.code === 'lcp-lazy');
		expect(at(true)?.message).toContain('The largest paint (img hero.jpg in Hero) carries loading="lazy"');
		expect(at(true)?.fix).toContain('fetchpriority="high"');
		expect(at(false)).toBeUndefined();
	});
});

describe('a shift the dev server made', () => {
	it('right after a component\'s CSS module arrived (dev): a note that it is the dev server\'s; on a build, not', () => {
		const at = (dev: boolean) =>
			analyze_page(
				page({
					...(dev ? { dev: true as const } : {}),
					vitals: { cls: 0.26 },
					visit: { nav: { res_start: 5 }, paints: { fcp: 30 }, viewport: [1280, 800], resources: [{ url: 'http://x/src/lib/Hero.svelte?svelte&type=style&lang.css', type: 'script', start: 36, end: 38 }] },
					shifts: [{ t: 58, value: 0.26, tag: 'div "Fast HTML only"' }]
				}),
				[],
				[],
				500
			).findings.find((f) => f.code === 'shift-cause' || f.code === 'vital-cls');
		const dev = at(true)!;
		expect(dev.severity).toBe('info');
		expect(dev.message).toContain("Hero.svelte's styles arrived: the dev server adds a component's CSS with JavaScript");
		expect(at(false)!.message).not.toContain('dev server');
	});
});

describe('a markup change that is only URL encoding', () => {
	it('encoding_only: the same once decoded; a real change, or a stray %, is not', () => {
		expect(encoding_only('<form action="?/remote=1a3/sign">', '<form action="?/remote=1a3%2Fsign">')).toBe(true);
		expect(encoding_only('<p>a</p>', '<p>b</p>')).toBe(false);
		expect(encoding_only('<p>50% off</p>', '<p>50% of</p>')).toBe(false);
		expect(encoding_only('<p>x</p>', '<p>x</p>')).toBe(false);
	});

	it('a note, not markup-changed (which still names a real change beside it)', () => {
		const r = analyze_page(
			page({
				islands: [{ fp: 'form', t0: 60, loaded: 80, done: 90, changed: true }, { fp: 'clock', t0: 60, loaded: 80, done: 90, changed: true }],
				snapshots: [
					{ fp: 'form', ssr: '<form action="?/remote=1a3/sign"></form>', hydrated: '<form action="?/remote=1a3%2Fsign"></form>' },
					{ fp: 'clock', ssr: '<p>server</p>', hydrated: '<p>browser</p>' }
				]
			}),
			[region('form', 'GuestbookForm'), region('clock', 'Clock')],
			[],
			500
		);
		expect(r.findings.find((f) => f.code === 'markup-encoded')?.message).toContain('GuestbookForm rendered the same markup');
		const changed = r.findings.find((f) => f.code === 'markup-changed')?.message ?? '';
		expect(changed.startsWith('Clock rendered different markup')).toBe(true);
		expect(changed).not.toContain('GuestbookForm');
	});
});

describe('dev compile on a first request', () => {
	// Hero: wakes at 60, its code in at 1460 (1400 ms), done 1470 — LCP 180, so 1290 ms "late"
	const late_page = (dev: boolean, compile_ms: number) =>
		page({
			...(dev ? { dev: true as const } : {}),
			visit: {
				nav: { res_start: 50, dcl: 200, load: 300 },
				paints: { fcp: 150, lcp: 180 },
				viewport: [1280, 800],
				// its files, fetched in its load window: the server answered in `compile_ms` (two of them overlapping)
				resources: [
					{ url: '/src/lib/Hero.svelte', type: 'script', start: 70, end: 80 + compile_ms, req_start: 72, res_start: 72 + compile_ms },
					{ url: '/src/lib/hero-util.ts', type: 'script', start: 80, end: 90 + compile_ms / 2, req_start: 82, res_start: 82 + compile_ms / 2 },
					{ url: '/@vite/client', type: 'script', start: 70, end: 75, req_start: 71, res_start: 73 }
				]
			},
			islands: [{ fp: 'hero', t0: 60, loaded: 1460, turn: 1462, done: 1470 }]
		});
	const late = (dev: boolean, compile_ms: number) => analyze_page(late_page(dev, compile_ms), [region('hero', 'Hero')], [], 3000).findings.find((f) => f.code === 'late-interactive');

	it('late only because the dev server compiled its code: a note that says so', () => {
		const f = late(true, 1100);
		expect(f?.severity).toBe('info');
		expect(f?.message).toContain('the dev server compiling its code on this first request');
	});

	it('late even without the compile, or not on the dev server: still a warning, said plainly', () => {
		expect(late(true, 100)?.severity).toBe('warn');
		expect(late(true, 100)?.message).not.toContain('dev server compiling');
		expect(late(false, 1100)?.severity).toBe('warn');
	});

	it('slow module: the compile named', () => {
		const r = analyze_page(late_page(true, 1100), [region('hero', 'Hero')], [], 3000);
		expect(r.findings.find((f) => f.code === 'slow-module')?.message).toContain('the dev server compiling the files on this first request');
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
		expect(f?.message).not.toContain('KB');
	});

	it('eager islands below the fold: their own bytes (each island once), a warning past 50 KB', () => {
		const at = (own: number) =>
			analyze_page(page(), [region('e', 'BelowEager', 'load', { top: 2000, own_bytes: own }), region('e2', 'BelowEager', 'load', { top: 2600, own_bytes: own })], [], 500).findings.find((x) => x.code === 'eager-offscreen');
		const small = at(12_288);
		expect(small?.severity).toBe('info');
		expect(small?.message).toBe('BelowEager starts below the first screen but loads code at page load. 12.0 KB of it is its own (no other island loads it): that much leaves the first load with a later wake.');
		expect(at(80_000)?.severity).toBe('warn');
		expect(at(416)?.message).toContain('Only 416 B of it is its own (the rest other islands load too): a later wake saves its hydration on the first load more than bytes.');
	});

	it('an eager island that draws nothing on this screen: not "below the first screen", the screens that show it', () => {
		const r = analyze_page(
			page(),
			[
				region('m', 'ShellBar', 'load', { top: 2000, hidden: true, shows_at: '(max-width: 900px)', own_bytes: 6_144 }),
				region('v', 'Lazy', 'visible', { top: 2000, hidden: true })
			],
			[],
			500
		);
		expect(codes(r)).not.toContain('eager-offscreen');
		const f = r.findings.find((x) => x.code === 'eager-hidden')!;
		expect(f.fps).toEqual(['m']);
		expect(f.message).toContain("ShellBar draws nothing on this screen");
		expect(f.message).toContain("the page's CSS shows it only at (max-width: 900px). 6.0 KB of that code is its own.");
		expect(f.fix).toContain("`with { wake: '(max-width: 900px)' }`");
		// no sheet says where: both ways out
		const bare = analyze_page(page(), [region('m', 'Palette', 'load', { top: 0, hidden: true })], [], 500).findings.find((x) => x.code === 'eager-hidden')!;
		expect(bare.message).toContain('hidden by its CSS or empty');
		expect(bare.fix).toContain("wake: 'interaction'");
		// two: each by what the sheets say, one unreadable not hiding the other's query
		const two = analyze_page(
			page(),
			[region('m', 'ShellBar', 'load', { top: 2000, hidden: true, shows_at: '(max-width: 900px)' }), region('c', 'CodeChrome', 'load', { top: 300, hidden: true })],
			[],
			500
		).findings.find((x) => x.code === 'eager-hidden')!;
		expect(two.message).toContain("the page's CSS shows ShellBar only at (max-width: 900px); CodeChrome has no box of its own (hidden by CSS, or empty).");
		expect(two.fix).toContain("Wake ShellBar by that media query (`with { wake: '(max-width: 900px)' }`)");
		expect(two.fix).toContain('For CodeChrome: if it shows only on some screens');
		// one that failed draws nothing because it broke: its failure says so, not this
		const broke = analyze_page(page(), [region('b', 'Broken', 'load', { top: 0, hidden: true })], [{ fp: 'b', message: 'boom' }], 500);
		expect(codes(broke)).not.toContain('eager-hidden');
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
		// …and render-blocking, the same file told again, is folded into it at its louder severity
		const both = analyze_page(page({ vitals: { fcp: 2400 }, visit: { ...page().visit!, nav: { res_start: 100, res_end: 150 }, paints: { fcp: 2400 }, resources: [{ url: 'https://a.test/slow.css?v=1', type: 'css', start: 160, end: 2360, blocking: true }] } } as never), [], [], 9000).findings;
		expect(both.map((f) => f.code)).not.toContain('render-blocking');
		expect(both.find((f) => f.code === 'slow-fcp')?.severity).toBe('warn');
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

	it('a slow first byte on a page the last profile found prerendered: a file being served, not a render to profile', () => {
		const brief = { ago_min: 2, render_ms: 4, top: null, calls: 0, calls_ms: 0, prerendered: 'file' as const };
		const f = analyze_page(page({ vitals: { ttfb: 1500 }, server_profiles: { '/docs/x': brief }, server_profile: brief, visit: { ...page().visit!, nav: { res_start: 1500, phases: { wait: 1400 } } as never } }), [], [], 9000).findings.find((x) => x.code === 'slow-ttfb')!;
		expect(f.message).toContain("found it prerendered: the server answered with the file the build wrote, no render ran — its first byte is a file being served, so a slow one is the host or the network, not a render to profile.");
		expect(f.fix).toMatch(/^The page is a prerendered file, and still slow to arrive/);
	});

	it('a first byte beyond the render: on the dev server, the page compiling (a note, reload); elsewhere, before the render', () => {
		const at = (dev: boolean, wait = 3800, ssr = 210) =>
			analyze_page({ ...page({ vitals: { ttfb: wait }, visit: { ...page().visit!, nav: { res_start: wait, phases: { wait }, server_timing: [{ name: 'ssr', ms: ssr, desc: 'SvelteKit render' }] } as never } }), ...(dev ? { dev: true } : {}) } as PageInput, [], [], 9000).findings.find((f) => f.code === 'slow-ttfb')!;
		const dev = at(true);
		expect(dev.message).toContain('Of the 3800 ms wait, the render was 210 ms; the other 3590 ms came before it — on the dev server, the page compiling on its first request.');
		expect(dev.fix).toMatch(/^Reload the page/);
		// (the dev server's own cost: a note, not a warning, whatever the rating)
		expect(dev.severity).toBe('info');
		const prod = at(false);
		expect(prod.message).toContain('the other 3590 ms came before it (a hook, a proxy, a cold start).');
		expect(prod.severity).toBe('warn');
		// the render is most of the wait: no split
		expect(at(true, 1000, 950).message).not.toContain('Of the');
	});

	it('the Page tab quotes the profiler’s last run of the page (devtools only), or says how to get one', () => {
		const at = (over: object) => analyze_page({ ...page({ vitals: { ttfb: 1500 }, visit: { ...page().visit!, nav: { res_start: 1500, phases: { wait: 1450 } } as never } }), ...over } as PageInput, [], [], 9000).findings.find((f) => f.code === 'slow-ttfb')!.message;
		// the profiler's own report: no such sentence (it is a profile)
		expect(at({})).not.toContain('profile');
		// devtools, no run yet: how to find out
		expect(at({ server_profiles: {} })).toContain('Profile this page (the Profiler tab) to see where the server’s time went.');
		// devtools, a run: quoted
		expect(at({ server_profiles: {}, server_profile: { ago_min: 3, render_ms: 1003, top: 'Mostly waiting, but no HTTP calls were seen', calls: 0, calls_ms: 0 } })).toContain("The profiler's last run of this page (3 min ago): the server render took 1003 ms, no outbound calls; it says: Mostly waiting, but no HTTP calls were seen.");
		expect(at({ server_profiles: {}, server_profile: { ago_min: 0.2, render_ms: 900, top: null, calls: 2, calls_ms: 640 } })).toContain('(just now): the server render took 900 ms, 2 outbound calls (640 ms).');
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
		// found late, and why: an <img> at an image's low priority
		const late = (paints: object, islands: PageInput['islands'] = []) => run({ ...at({ lcp: 3000, lcp_url: hero, ...paints }, [{ url: hero, type: 'img', start: 2600, end: 2900 }]), islands })!.fix;
		expect(late({ lcp_tag: 'img' })).toMatch(/^It is an `<img>` the browser could find in the HTML, but an image starts at low priority/);
		// …already high: something before it held the browser back
		expect(late({ lcp_tag: 'img', lcp_priority: 'high' })).toMatch(/^It already asks for high priority/);
		// a CSS background
		expect(late({ lcp_tag: 'div' })).toMatch(/^It is a CSS background image \(on the div\)/);
		// its island's code added it: the request began after the island hydrated
		expect(late({ lcp_tag: 'img', lcp_fp: 'h' }, [{ fp: 'h', t0: 100, loaded: 2000, done: 2550 }])).toBe(
			"Its request began at 2600 ms, after Hero woke (hydrated at 2550 ms): the server HTML did not carry it, the island's code added it. Render the `<img>` (the same src) in the island's server markup, so the browser finds it in the HTML."
		);
		// lazy: its own late start, whatever woke
		expect(late({ lcp_tag: 'img', lcp_fp: 'h', lcp_lazy: true }, [{ fp: 'h', t0: 100, loaded: 2000, done: 2550 }])).toMatch(/^It carries `loading="lazy"`/);
		// nothing known of the element: the general advice
		expect(late({})).toMatch(/^The browser found it late/);
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

		it('a handler that forced layout: how much of it, and the read-then-write fix; a little never', () => {
			const at_forced = (forced: number) =>
				find(analyze_page(page({ vitals: { inp: 300 }, visit: at({ interaction: it_of({ scripts: [{ url: `${origin}/_app/immutable/chunks/events-B1q.js`, fn: 'handle_event_propagation', invoker: 'DOCUMENT.onclick', ms: 268, phase: 'handler', forced }] }) }) }), [region('s', 'SlowSave')], [], 3000))!;
			const f = at_forced(190);
			expect(f.message).toContain("270 ms in its handlers (mostly SlowSave's own click handler; 190 ms of it the browser laying the page out again because the code read sizes after changing it)");
			expect(f.fix).toMatch(/^Much of the handler is forced layout/);
			const little = at_forced(12);
			expect(little.message).not.toContain('laying the page out');
			expect(little.fix).toMatch(/^The handler itself is the cost/);
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

	it('a server transform’s restore gone wrong: a host upgraded first, and a mismatch, each named with its island', () => {
		const r = analyze_page(
			page({
				restore_events: [
					{ kind: 'late', host: 'demo-card', t: 20, island: 'f1' },
					{ kind: 'late', host: 'demo-card', t: 21, island: 'f1' },
					{ kind: 'mismatch', host: 'x-nav', t: 22, diff: '<x-nav> > [1]: Svelte has <i>, the restored markup has nothing' }
				]
			}),
			[region('f1', 'LateCard')],
			[],
			3000
		);
		const late = r.findings.find((x) => x.code === 'restore-late')!;
		expect(late.message).toBe("<demo-card> ×2 were upgraded by their component before ogygia restored them: they keep the server render's scoped form, and LateCard hydrates against that (expect a heal or a client re-render).");
		expect(late.fps).toEqual(['f1']);
		expect(late.fix).toMatch(/a blocking <script> \(no type=module, no defer\)/);
		const mis = r.findings.find((x) => x.code === 'restore-mismatch')!;
		expect(mis.message).toContain('<x-nav> different from what Svelte rendered, after ogygia restored it: <x-nav> > [1]: Svelte has <i>');
		expect(analyze_page(page(), [], [], 3000).findings.some((x) => x.code.startsWith('restore-'))).toBe(false);
	});

	it('a bare attribute on a custom element (server "", browser "true") is named as the cause', () => {
		const ssr = '<demo-card class="own" data-lab-card=""><button>count 0</button></demo-card>';
		const hyd = '<demo-card class="own" data-lab-card="true"><button>count 0</button></demo-card>';
		const d = first_difference(ssr, hyd)!;
		expect(boolean_attr_at(ssr, hyd, d.at)).toEqual({ name: 'data-lab-card', tag: 'demo-card', now: 'true' });
		// a plain element, or another kind of difference: not this cause
		expect(boolean_attr_at('<p data-x="">a</p>', '<p data-x="true">a</p>', 11)).toBeNull();
		expect(boolean_attr_at('<x-a data-x="1">', '<x-a data-x="2">', 13)).toBeNull();
		const r = analyze_page(
			page({ islands: [{ fp: 'f1', t0: 60, loaded: 80, turn: 80, done: 84, changed: true }], snapshots: [{ fp: 'f1', ssr, hydrated: hyd }] }),
			[region('f1', 'LabCard')],
			[],
			3000
		).findings.find((x) => x.code === 'markup-changed');
		expect(r?.fix).toMatch(/^`data-lab-card` on <demo-card> is written bare/);
	});

	it('a batch request that did not carry its holes is named with what answered and what it cost', () => {
		const find = (b: object) => analyze_page(page({ hole_batches: [b as never] }), [], [], 3000).findings.find((x) => x.code === 'hole-batch-missed');
		const refused = find({ sent: 4, delivered: 0, status: 405, names: ['BatchHole', 'BatchHole', 'Cart', 'BatchHole'] })!;
		expect(refused.severity).toBe('warn');
		expect(refused.message).toBe('The one request for 4 holes (BatchHole ×3 and Cart) was answered 405: every one then fetched on its own — 5 requests instead of 1, each starting only after the batch ended.');
		expect(refused.fix).toMatch(/^Something in front of ogygia\.handle\(\) took the batch/);
		const bounced = find({ sent: 2, delivered: 0, status: 200, refused: 'redirected', final_url: 'https://x.test/account/?r=1', names: ['A', 'B'] })!;
		expect(bounced.message).toContain('was redirected to /account/?r=1');
		const partly = find({ sent: 3, delivered: 2, status: 200, names: ['A', 'B', 'C'] })!;
		expect(partly.severity).toBe('info');
		expect(partly.message).toContain('ended without 1 of them: 1 then fetched on its own — 2 requests instead of 1');
		expect(partly.fix).toMatch(/^The server could not render those holes in the batch/);
		expect(find({ sent: 3, delivered: 3, status: 200, names: [] })).toBeUndefined();
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
		// BATCHED: four holes in one request, the last part landed 1.2 s in — the server, never the gate
		// (even though, timed like separate requests, three others "were ahead" of it)
		const b = (n: number, part: number) => ({ name: `B${n}`, below_fold: false, shown_at: 100, left_at: 110, first_at: part, end_at: part, wait_ms: part + 10 - 100, batch_size: 4 });
		const batched = analyze_page(page({ hole_waits: [b(1, 150), b(2, 150), b(3, 150), b(4, 1310)] }), [], [], 3000).findings.find((x) => x.code === 'hole-slow')!;
		expect(batched.message).toContain('B4 (1.2 s: 1.2 s waiting on the server, its part of one request for 4 holes)');
		expect(batched.fix).toMatch(/^The server is the wait/);
		expect(batched.fix).not.toContain('hole requests at a time');
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

	it("a build's small blocking stylesheets: the inlineStyleThreshold that takes them off the paint", () => {
		const css = (name: string, kb: number, end = 400) => ({ url: `http://x/_app/immutable/assets/${name}.css`, type: 'css', start: 60, end, size: Math.round(kb * 1024), blocking: true });
		const resources = [css('big', 17), css('shell', 7), css('chrome', 3), css('header', 2)];
		const f = analyze_page(page({ visit: { ...page().visit!, paints: { fcp: 420 }, resources } }), [], [], 500).findings.find((x) => x.code === 'render-blocking')!;
		expect(f.fix).toMatch(/^With `kit: \{ inlineStyleThreshold: 8192 \}` in svelte\.config\.js, 3 of these stylesheets \(12\.0 KB\) arrive inside the HTML: 1 file left to wait on instead of 4\./);
		// the dev server's files are no build's: the general advice
		const dev = resources.map((r) => ({ ...r, url: r.url.replace('/_app/immutable/assets/', '/src/lib/') }));
		expect(analyze_page(page({ visit: { ...page().visit!, paints: { fcp: 420 }, resources: dev } }), [], [], 500).findings.find((x) => x.code === 'render-blocking')!.fix).toMatch(/^Inline small stylesheets/);
	});

	it('the largest paint in an island that rendered it again on hydration', () => {
		const with_paints = (lcp_replaced?: true, recovered?: true) =>
			analyze_page(
				page({
					visit: { ...page().visit!, paints: { fcp: 50, lcp: 70, lcp_fp: 'hero', lcp_tag: 'h1', ...(lcp_replaced ? { lcp_replaced } : {}) } },
					islands: [{ fp: 'hero', t0: 60, loaded: 80, done: 90, changed: true, ...(recovered ? { recovered } : {}) }]
				}),
				[region('hero', 'Hero')],
				[],
				500
			);
		// its element taken out while the island stayed, or the island rebuilt: repainted
		expect(codes(with_paints(true))).toContain('lcp-repaint');
		expect(codes(with_paints(undefined, true))).toContain('lcp-repaint');
		// changed elsewhere (an attribute), the element still there, painted before it woke: nothing repainted
		expect(codes(with_paints())).not.toContain('lcp-repaint');
		// the largest paint after it woke (the browser counted the island's own heading): repainted
		const late = analyze_page(
			page({ visit: { ...page().visit!, paints: { fcp: 50, lcp: 95, lcp_fp: 'hero', lcp_tag: 'h1' } }, islands: [{ fp: 'hero', t0: 60, loaded: 80, done: 90, changed: true }] }),
			[region('hero', 'Hero')],
			[],
			500
		);
		expect(codes(late)).toContain('lcp-repaint');
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
