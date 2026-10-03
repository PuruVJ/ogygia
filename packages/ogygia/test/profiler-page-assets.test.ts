// The page's weight: every file the document loads at start, found in the HTML (string scanning)
// and weighed through the app, following each module's static imports.
import { describe, test, expect } from 'vitest';
import { scan_assets, static_imports, dynamic_imports, tag_attrs, weigh_assets, runtime_scripts, type Weight } from '../src/profiler/page-assets.js';

const KIT_PAGE = `<!doctype html><html><head>
<link href="./_app/immutable/assets/0.abc.css" rel="stylesheet">
<link rel="stylesheet" href="/print.css" media="print">
<link rel="modulepreload" href="./_app/immutable/entry/start.X.js">
<link rel="modulepreload" href="./_app/immutable/chunks/big.Y.js">
<link rel="preload" as="font" href="/f.woff2" crossorigin>
<script src="/legacy.js"></script>
<script src="/async.js" async></script>
<!-- <script src="/commented.js"></script> -->
</head><body><div>hi</div>
<img src="/hero.webp" alt=""><img src="/later.webp" loading="lazy">
<script>
  { __sveltekit_x = { base: '' }; Promise.all([import("./_app/immutable/entry/start.X.js"), import('./_app/immutable/entry/app.Z.js')]).then(() => {}); }
</script>
<script type="application/json" data-x>{"a":1}</script>
<style>.a{color:red}</style>
</body></html>`;

describe('scan_assets', () => {
	test('finds every file the document loads at start, with what blocks', () => {
		const { refs, inline } = scan_assets(KIT_PAGE);
		const by = Object.fromEntries(refs.map((r) => [r.url, r]));
		expect(by['./_app/immutable/assets/0.abc.css']).toMatchObject({ kind: 'style', blocking: true });
		expect(by['/print.css'].blocking).toBe(false);
		expect(by['./_app/immutable/entry/start.X.js'].via).toBe('modulepreload'); // first ask wins, deduped
		expect(by['./_app/immutable/entry/app.Z.js'].via).toBe('inline-import');
		expect(by['/f.woff2'].kind).toBe('font');
		expect(by['/legacy.js'].blocking).toBe(true);
		expect(by['/async.js'].blocking).toBe(false);
		expect(by['/hero.webp'].kind).toBe('image');
		expect(by['/later.webp']).toBeUndefined(); // lazy image
		expect(by['/commented.js']).toBeUndefined();
		expect(inline.script).toBeGreaterThan(50); // the start script; not the JSON island
		expect(inline.style).toBe('.a{color:red}'.length);
	});

	test('attributes: quoted, unquoted, valueless, entities', () => {
		const a = tag_attrs(`<link rel=preload as="script" href='/a.js?x=1&amp;y=2' crossorigin>`);
		expect(a.get('rel')).toBe('preload');
		expect(a.get('href')).toBe('/a.js?x=1&y=2');
		expect(a.has('crossorigin')).toBe(true);
	});
});

describe('import scanners', () => {
	test('static imports of bundled output, not dynamic ones or look-alikes', () => {
		const code = `import{a as b}from"./chunk.A.js";import"./side.B.js";export*from'../c.C.js';const x=import("./lazy.D.js");const s="from";platform.from("./nope.js");import{y}from"svelte";`;
		expect(static_imports(code).sort()).toEqual(['../c.C.js', './chunk.A.js', './side.B.js']);
		expect(dynamic_imports(code)).toEqual(['./lazy.D.js']);
	});
});

describe('Kit route nodes', () => {
	test('the page\'s own node (reachable only by app.js\'s dynamic import) is weighed; other routes\' are not', async () => {
		const html = `<html><head></head><body><script>{ Promise.all([import("./_app/immutable/entry/start.S.js"), import("./_app/immutable/entry/app.A.js")]).then(([kit, app]) => { kit.start(app, element, { node_ids: [0, 5], data: [] }); }); }</script></body></html>`;
		const files: Record<string, string> = {
			'/_app/immutable/entry/start.S.js': 'export const s=1;',
			'/_app/immutable/entry/app.A.js': 'const n=[()=>r(()=>import("../nodes/0.N0.js")),()=>r(()=>import("../nodes/1.N1.js")),()=>r(()=>import("../nodes/5.N5.js")),()=>r(()=>import("../nodes/50.N50.js"))];',
			'/_app/immutable/nodes/0.N0.js': 'layout',
			'/_app/immutable/nodes/5.N5.js': 'import"../chunks/editor.E.js";' + 'p'.repeat(100),
			'/_app/immutable/chunks/editor.E.js': 'e'.repeat(50_000),
			'/_app/immutable/nodes/1.N1.js': 'other route',
			'/_app/immutable/nodes/50.N50.js': 'other route'
		};
		const r = await weigh_assets({
			html,
			page_url: 'http://x/page',
			cache: new Map(),
			fetch_url: async (u) => {
				const body = files[new URL(u, 'http://x/page').pathname];
				return body === undefined ? new Response('', { status: 404 }) : new Response(body);
			}
		});
		const paths = r.assets.map((a) => new URL(a.url).pathname);
		expect(paths).toContain('/_app/immutable/nodes/5.N5.js');
		expect(paths).toContain('/_app/immutable/chunks/editor.E.js'); // the node's own imports follow
		expect(paths).toContain('/_app/immutable/nodes/0.N0.js');
		expect(paths).not.toContain('/_app/immutable/nodes/1.N1.js');
		expect(paths).not.toContain('/_app/immutable/nodes/50.N50.js'); // `/nodes/5.` must not match 50
		expect(r.totals.js).toBeGreaterThan(50_000);
	});

	test("the ogygia runtime's on-demand parts are its own, loaded later (with what they import)", async () => {
		const html = '<html><head><script type="module" data-ogygia-runtime src="/_app/immutable/og-runtime.R.js"></script></head><body></body></html>';
		const files: Record<string, string> = {
			'/_app/immutable/og-runtime.R.js': 'const h=()=>import(`./chunks/hydrate.H.js`);export{h};',
			'/_app/immutable/chunks/hydrate.H.js': 'import{a}from"./svelte.S.js";' + 'x'.repeat(2000),
			'/_app/immutable/chunks/svelte.S.js': 'y'.repeat(3000)
		};
		const r = await weigh_assets({
			html,
			page_url: 'http://x/page',
			cache: new Map(),
			fetch_url: async (u) => {
				const body = files[new URL(u, 'http://x/page').pathname];
				return body === undefined ? new Response('', { status: 404 }) : new Response(body);
			}
		});
		const by = Object.fromEntries(r.assets.map((a) => [new URL(a.url).pathname, a]));
		expect(by['/_app/immutable/og-runtime.R.js'].runtime).toBe(true);
		expect(by['/_app/immutable/chunks/hydrate.H.js']).toMatchObject({ via: 'runtime-phase', lazy: true, phase: true });
		expect(by['/_app/immutable/chunks/svelte.S.js']).toMatchObject({ via: 'static-import', lazy: true, phase: true });
		// on demand, not at start: the visit says whether they loaded
		expect(r.totals.lazy_js).toBe(files['/_app/immutable/chunks/hydrate.H.js'].length + 3000);
	});
});

describe('weigh_assets', () => {
	test('weighs every file, follows static imports, keeps lazy islands apart', async () => {
		const files: Record<string, string> = {
			'/_app/immutable/entry/start.X.js': 'import{a}from"../chunks/big.Y.js";export const s=1;',
			'/_app/immutable/chunks/big.Y.js': 'x'.repeat(5000) + ';import"./dep.W.js";',
			'/_app/immutable/chunks/dep.W.js': 'y'.repeat(1000),
			'/_app/immutable/entry/app.Z.js': 'z'.repeat(300),
			'/_app/immutable/assets/0.abc.css': '.a{}'.repeat(100),
			'/legacy.js': 'l'.repeat(200),
			'/async.js': 'a',
			'/f.woff2': 'f'.repeat(400),
			'/hero.webp': 'h'.repeat(900),
			'/print.css': '.p{}',
			'/island/lazy.js': 'q'.repeat(700)
		};
		const cache = new Map<string, Weight | null>();
		const fetch_url = async (u: string) => {
			const path = new URL(u, 'http://x/page').pathname;
			const body = files[path];
			return body === undefined ? new Response('no', { status: 404 }) : new Response(body);
		};
		const r = await weigh_assets({
			html: KIT_PAGE,
			page_url: 'http://x/page',
			fetch_url,
			cache,
			gzip: (b) => Math.ceil(b.byteLength / 3),
			extra: [{ url: '/island/lazy.js', kind: 'script', blocking: false, via: 'island', lazy: true }]
		});
		const urls = r.assets.map((a) => new URL(a.url).pathname);
		expect(urls).toContain('/_app/immutable/chunks/dep.W.js'); // found through two static imports
		expect(r.totals.js_files).toBe(6); // start, big, dep, app, legacy, async
		expect(r.totals.js).toBe(files['/_app/immutable/entry/start.X.js'].length + files['/_app/immutable/chunks/big.Y.js'].length + 1000 + 300 + 200 + 1);
		expect(r.totals.lazy_js).toBe(700);
		expect(r.totals.blocking_count).toBe(2); // the head css + the sync script
		expect(r.totals.wire).toBeGreaterThan(r.html.wire);
		expect(r.missed).toEqual([]);
		// a second report reuses the cache: nothing refetched
		let calls = 0;
		await weigh_assets({ html: KIT_PAGE, page_url: 'http://x/page', fetch_url: async (u) => (calls++, fetch_url(u)), cache, extra: [] });
		expect(calls).toBe(0);
	});
});

describe('runtime_scripts', () => {
	test("this app's island entries no HTML named (a hole's islands) are counted apart; a CDN's parts are not", () => {
		const r = runtime_scripts(
			[{ url: 'http://x/_app/immutable/og-runtime.A.js' }],
			[
				{ url: 'http://x/_app/immutable/og-region.69b7a9b1ab5a.B.js', type: 'script', start: 100, size: 30_000 },
				{ url: 'http://x/_app/immutable/chunks/C.js', type: 'script', start: 110, size: 20_000 },
				{ url: 'https://cdn.example/npm/lib@1/dist/part.js', type: 'script', start: 120, size: 9_000 },
				{ url: 'http://x/_app/immutable/og-runtime.A.js', type: 'script', start: 5, size: 18_000 }
			],
			'http://x',
			10_000
		)!;
		expect(r.files).toBe(3);
		expect(r.island_entries).toBe(1);
		expect(r.by.map((b) => b.who)).toEqual(['this app', 'cdn.example lib']);
	});
});
