/**
 * ENTRY IDENTITY vs LOCATION, every layer. A hydrate island's entry and the runtime used to be
 * served under stable names from `immutable/` — a year-long cache on a file whose content changes
 * every build. Now: the IDENTITY stays the stable URL (every key: the `entry` attribute, the handoff's
 * maps, the fingerprint), the LOCATION is the content-hashed file the bundler named, and the stable
 * name is a shim of it. Layer by layer:
 *   build     — the driver emits by name, keeps refs, maps identity → location, writes the shims
 *   collector — every handoff map keyed by identity, the entry's own file never its own dependency
 *   handoff   — `entryLocation` reads it at render time (the server bundle is built first)
 *   server    — the one runtime bootstrap, Region's `src`, preload hints, the graph's `s` map
 * (the browser's half: test/browser/entry-location*.test.ts; the real two-build proof:
 * internal/bench/cache-bust-check.mjs)
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import { island_shim_source, runtime_shim_source } from '../src/compiler/link/entry-shim.js';
import { collectIslandDepModulepreloads, island_deps_module } from '../src/compiler/link/island-deps.js';
import { decode_island_graph, decode_island_locations, encode_island_graph } from '../src/island-graph.js';
import { DocumentTail, island_graph_script } from '../src/server/document-tail.js';
import { entry_src, runtime_bootstrap } from '../src/server/entry-location.js';
import { plan_props_wire } from '../src/server/props-wire.js';
import { set_entry_locations, set_island_deps } from './_stubs/virtual-island-deps.js';
import Region from '../src/Region.svelte';
import Tiny from './_fixtures/Tiny.svelte';
import { Compiler, Program, CompileCtx, normalize_import_keys } from '../dist/compiler/index.js';

const region = Region as unknown as Component<Record<string, unknown>>;
const GRAPH_RE = /<script type="application\/json" data-ogygia-graph>([^<]*)<\/script>/;

afterEach(() => {
	set_entry_locations({});
	set_island_deps({});
});

// ── the stable-name shims ────────────────────────────────────────────────────────────────────────
describe('the stable-name shim: a plain static re-export of its location', () => {
	it('an island shim re-exports every export and the default, by a relative path', () => {
		expect(island_shim_source('_app/immutable/og-region.abc.js', '_app/immutable/chunks/Ab12.js')).toBe(
			'export * from "./chunks/Ab12.js";\nexport { default } from "./chunks/Ab12.js";\n'
		);
	});
	it('wherever the bundler puts the location (an entry dir, a custom appDir, a deeper shim)', () => {
		expect(island_shim_source('_app/immutable/og-region.abc.js', '_app/immutable/entry/og-region.abc.X1.js')).toContain('"./entry/og-region.abc.X1.js"');
		expect(island_shim_source('my/app/immutable/og-region.abc.js', 'my/app/immutable/chunks/Q.js')).toContain('"./chunks/Q.js"');
		expect(island_shim_source('_app/immutable/deep/og-region.abc.js', '_app/immutable/chunks/Q.js')).toContain('"../chunks/Q.js"');
	});
	it('the runtime shim runs the runtime (it has no exports)', () => {
		expect(runtime_shim_source('_app/immutable/og-runtime.1234.js', '_app/immutable/chunks/Rt.js')).toBe('import "./chunks/Rt.js";\n');
	});
	it('the shim names no bundler magic (no import.meta file URLs, no top-level await)', () => {
		const src = island_shim_source('_app/immutable/og-region.abc.js', '_app/immutable/chunks/Ab12.js') + runtime_shim_source('a/og-runtime.js', 'a/chunks/R.js');
		expect(src).not.toMatch(/import\.meta|await /);
	});
});

// ── the collector: every map keyed by identity ────────────────────────────────────────────────────
describe('the collector keys every map by IDENTITY, the location being a hashed file', () => {
	const ID_A = '/_app/immutable/og-region.aaaaaaaaaaaa.js';
	const ID_B = '/_app/immutable/og-region.bbbbbbbbbbbb.js';
	const RT_ID = '/_app/immutable/og-runtime.0123456789ab-feat.js';
	const bundle = {
		'_app/immutable/chunks/LocA.js': { type: 'chunk', fileName: '_app/immutable/chunks/LocA.js', imports: ['_app/immutable/chunks/Shared.js'], moduleIds: ['/app/A.svelte'], viteMetadata: { importedCss: ['_app/immutable/assets/A.css'] } },
		'_app/immutable/chunks/LocB.js': { type: 'chunk', fileName: '_app/immutable/chunks/LocB.js', imports: ['_app/immutable/chunks/Shared.js'], moduleIds: ['/app/B.svelte'] },
		'_app/immutable/chunks/Shared.js': { type: 'chunk', fileName: '_app/immutable/chunks/Shared.js', imports: [], moduleIds: ['/node_modules/svelte/internal.js'] },
		'_app/immutable/chunks/Rt.js': { type: 'chunk', fileName: '_app/immutable/chunks/Rt.js', imports: ['_app/immutable/chunks/Shared.js'], moduleIds: ['virtual:runtime'] },
		// the shims are assets: never facades, never keys
		'_app/immutable/og-region.aaaaaaaaaaaa.js': { type: 'asset', fileName: '_app/immutable/og-region.aaaaaaaaaaaa.js' },
		'_app/immutable/og-runtime.0123456789ab-feat.js': { type: 'asset', fileName: '_app/immutable/og-runtime.0123456789ab-feat.js' }
	};
	const entries = {
		islands: new Map([
			['_app/immutable/chunks/LocA.js', ID_A],
			['_app/immutable/chunks/LocB.js', ID_B]
		]),
		runtime: RT_ID
	};
	const map = collectIslandDepModulepreloads(bundle as never, [], null, null, null, '_app/immutable/chunks/Rt.js', entries);

	it('js / css / page / remotes are keyed by the identity, never the hashed name', () => {
		expect(Object.keys(map.js).sort()).toEqual([ID_A, ID_B, RT_ID].sort());
		expect(map.js[ID_A]).toEqual(['/_app/immutable/chunks/Shared.js']);
		expect(map.css[ID_A]).toEqual(['/_app/immutable/assets/A.css']);
		expect(Object.keys(map.page).sort()).toEqual([ID_A, ID_B].sort());
		expect(Object.keys(map.remotes).sort()).toEqual([ID_A, ID_B].sort());
		expect(Object.keys(map.js).some((k) => k.includes('/chunks/Loc'))).toBe(false);
	});
	it("an entry's own file is never listed as its own dependency", () => {
		expect(map.js[ID_A]).not.toContain('/_app/immutable/chunks/LocA.js');
		expect(map.js[ID_B]).not.toContain('/_app/immutable/chunks/LocB.js');
	});
	it("the runtime's static imports ride under the runtime's identity", () => {
		expect(map.js[RT_ID]).toEqual(['/_app/immutable/chunks/Shared.js']);
	});
	it('without entries (a bundle from before hashing): a stable-named facade is its own identity, as before', () => {
		const legacy = collectIslandDepModulepreloads(
			{ '_app/immutable/og-region.cccccccccccc.js': { type: 'chunk', fileName: '_app/immutable/og-region.cccccccccccc.js', imports: ['_app/immutable/chunks/S.js'] }, '_app/immutable/chunks/S.js': { type: 'chunk', fileName: '_app/immutable/chunks/S.js', imports: [] } } as never
		);
		expect(legacy.js['/_app/immutable/og-region.cccccccccccc.js']).toEqual(['/_app/immutable/chunks/S.js']);
	});
	it('with entries given, a chunk that merely LOOKS like a stable name is not an entry', () => {
		const odd = collectIslandDepModulepreloads(
			{ '_app/immutable/og-region.dddddddddddd.js': { type: 'chunk', fileName: '_app/immutable/og-region.dddddddddddd.js', imports: [] } } as never,
			[],
			null,
			null,
			null,
			null,
			{ islands: new Map(), runtime: null }
		);
		expect(Object.keys(odd.js)).toEqual([]);
	});
});

// ── the handoff, read at render time ──────────────────────────────────────────────────────────────
describe('entryLocation: the handoff read at render time', () => {
	const load_module = async (src: string) => {
		const file = path.join(os.tmpdir(), `og-entry-loc-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
		fs.writeFileSync(file, src);
		try {
			return await import(file);
		} finally {
			fs.rmSync(file, { force: true });
		}
	};
	const with_handoff = (json: unknown) => island_deps_module(true, false).replace("'__OGYGIA_ISLAND_DEPS_INLINE__'", JSON.stringify(JSON.stringify(json)));

	it('an identity the build mapped → its location', async () => {
		const m = await load_module(with_handoff({ entries: { '/_app/immutable/og-region.aaaaaaaaaaaa.js': '/_app/immutable/chunks/LocA.js' } }));
		expect(m.entryLocation('/_app/immutable/og-region.aaaaaaaaaaaa.js')).toBe('/_app/immutable/chunks/LocA.js');
		expect(m.entryLocation('/_app/immutable/og-region.ffffffffffff.js')).toBeNull();
		expect(m.entryLocation('')).toBeNull();
	});
	it('a handoff from before hashing (no entries), or a malformed one → null (the identity is served)', async () => {
		expect((await load_module(with_handoff({ js: {} }))).entryLocation('/x.js')).toBeNull();
		expect((await load_module(with_handoff({ entries: 'nope' }))).entryLocation('/x.js')).toBeNull();
		expect((await load_module(with_handoff({ entries: { '/x.js': 42 } }))).entryLocation('/x.js')).toBeNull();
	});
	it('the client leg and the dev server know no location', async () => {
		expect((await load_module(island_deps_module(false, false))).entryLocation('/x.js')).toBeNull();
		expect((await load_module(island_deps_module(true, true))).entryLocation('/x.js')).toBeNull();
	});
});

// ── the island graph's `s` map ────────────────────────────────────────────────────────────────────
describe("the island graph's `s`: locations of entries no element carries", () => {
	it('round-trips beside the graph, which is unchanged', () => {
		const graph = new Map([['/a.js', ['/svelte.js']]]);
		const locations = new Map([['/snip.js', '/chunks/Snip.js']]);
		const text = encode_island_graph(graph, locations);
		expect(decode_island_graph(text)).toEqual(graph);
		expect(decode_island_locations(text)).toEqual(locations);
	});
	it('no locations → no `s` key (byte-identical to the format before)', () => {
		const graph = new Map([['/a.js', ['/svelte.js']]]);
		expect(encode_island_graph(graph, new Map())).toBe(encode_island_graph(graph));
		expect(JSON.parse(encode_island_graph(graph))).not.toHaveProperty('s');
	});
	it('malformed `s` entries are dropped, the rest kept; garbage decodes to nothing', () => {
		expect(decode_island_locations('{"h":[],"e":{},"s":{"/a.js":"/A.js","/b.js":7,"/c.js":null}}')).toEqual(new Map([['/a.js', '/A.js']]));
		expect(decode_island_locations('not json')).toEqual(new Map());
		expect(decode_island_locations('{"h":[],"e":{},"s":"x"}')).toEqual(new Map());
	});
	it('a graph script is written for locations alone (a page whose only entry is a snippet)', () => {
		const html = island_graph_script(new Map(), new Map([['/snip.js', '/chunks/Snip.js']]));
		expect(decode_island_locations(GRAPH_RE.exec(html)![1])).toEqual(new Map([['/snip.js', '/chunks/Snip.js']]));
		expect(island_graph_script(new Map(), null)).toBe('');
	});
});

// ── the document tail ─────────────────────────────────────────────────────────────────────────────
describe('the document tail', () => {
	it('carries the locations it was told (first wins), and is not empty for them alone', () => {
		const tail = new DocumentTail();
		expect(tail.empty).toBe(true);
		tail.locate('/snip.js', '/chunks/Snip.js');
		tail.locate('/snip.js', '/chunks/Other.js');
		expect(tail.empty).toBe(false);
		expect(decode_island_locations(GRAPH_RE.exec(tail.render())![1]).get('/snip.js')).toBe('/chunks/Snip.js');
	});
	it("an island's recorded JS closure leads with its location — the file the profiler weighs", () => {
		const tail = new DocumentTail();
		tail.props('fp1', plan_props_wire({}, '/id.js'), { entry: '/id.js', name: 'T', module_url: '/chunks/Loc.js', wake: 'load', interactivity: null });
		tail.graph('/id.js', ['/chunks/Dep.js'], 'fp1', '/chunks/Loc.js');
		const rows = (tail.render(null, true), tail.island_rows())!;
		expect(rows[0].hints).toEqual(['/chunks/Loc.js', '/chunks/Dep.js']);
		// …the graph itself stays keyed by the identity
		expect([...decode_island_graph(GRAPH_RE.exec(tail.render())![1]).keys()]).toEqual(['/id.js']);
	});
});

// ── the server: the one runtime bootstrap ─────────────────────────────────────────────────────────
describe('the runtime bootstrap (server/entry-location.ts), shared by every document path', () => {
	it('loads the location, with the runtime identity’s static imports preloaded', () => {
		set_entry_locations({ '/og-runtime.js': '/chunks/Rt.js' });
		set_island_deps({ '/og-runtime.js': ['/chunks/Shared.js'] });
		const html = runtime_bootstrap();
		expect(html).toContain('<script type="module" data-ogygia-runtime src="/chunks/Rt.js"></script>');
		expect(html).toContain('<link rel="modulepreload" href="/chunks/Shared.js" data-ogygia-runtime-dep>');
		expect(html).not.toContain('/og-runtime.js');
	});
	it('no location (dev, a handoff from before hashing): the identity itself', () => {
		expect(runtime_bootstrap()).toContain('src="/og-runtime.js"');
		expect(entry_src('/x/og-region.aaaaaaaaaaaa.js')).toBe('/x/og-region.aaaaaaaaaaaa.js');
		expect(entry_src('')).toBe('');
	});
	it('the base / assets prefix applies to the location and every preload', () => {
		set_entry_locations({ '/og-runtime.js': '/chunks/Rt.js' });
		set_island_deps({ '/og-runtime.js': ['/chunks/Shared.js'] });
		const html = runtime_bootstrap((u) => 'https://cdn.test' + u);
		expect(html).toContain('src="https://cdn.test/chunks/Rt.js"');
		expect(html).toContain('href="https://cdn.test/chunks/Shared.js"');
	});
});

// ── Region: identity and location on the element ──────────────────────────────────────────────────
describe('Region writes the identity as `entry` and the location as `src`', () => {
	const ENTRY = '/islands/tiny.js';
	const render_island = () => {
		const out = render(region, { props: { __mode: 'island', __entry: ENTRY, __component: Tiny, __props: {} } });
		return out.head + out.body;
	};
	const attr = (html: string, name: string) => new RegExp(`<ogygia-region[^>]*\\s${name}="([^"]*)"`).exec(html)?.[1];

	it('a mapped island: `entry` stays its identity, `src` is its location', () => {
		set_entry_locations({ [ENTRY]: '/chunks/Tiny.Hh12.js' });
		const html = render_island();
		expect(attr(html, 'entry')).toBe(ENTRY);
		expect(attr(html, 'src')).toBe('/chunks/Tiny.Hh12.js');
	});
	it('an unmapped island (dev, old handoff): no `src` at all — the runtime loads the identity', () => {
		expect(attr(render_island(), 'src')).toBeUndefined();
	});
	it('the fingerprint is the identity’s: a new location (a new build) never changes it', () => {
		const fp = (html: string) => attr(html, 'data-og-fp');
		const before = fp(render_island());
		set_entry_locations({ [ENTRY]: '/chunks/Tiny.Zz99.js' });
		expect(fp(render_island())).toBe(before);
	});
	it('the client wrapper’s location (`__src`) wins where the server has none', () => {
		const out = render(region, { props: { __mode: 'island', __entry: ENTRY, __src: '/from/client.js', __component: Tiny, __props: {} } });
		expect(attr(out.body, 'src')).toBe('/from/client.js');
	});
});

// ── the router's next-page warm reads both off the fetched HTML ───────────────────────────────────
describe("the router's warm scan: identity and location off an open tag", () => {
	it('reads each attribute exactly, never a longer name that ends the same', async () => {
		const { tag_attr } = await import('../src/runtime/router-nav.js');
		const attrs = ' entry="./_app/immutable/og-region.aaaaaaaaaaaa.js" data-src="./nope.js" src="./_app/immutable/chunks/Loc.js" wake="load"';
		expect(tag_attr(attrs, 'entry')).toBe('./_app/immutable/og-region.aaaaaaaaaaaa.js');
		expect(tag_attr(attrs, 'src')).toBe('./_app/immutable/chunks/Loc.js');
		expect(tag_attr(' entry="/a.js" data-src="/b.js"', 'src')).toBeNull();
		expect(tag_attr(' entry="/a.js"', 'src')).toBeNull();
		expect(tag_attr(' src="/unterminated', 'src')).toBeNull();
	});
});

// ── the driver: emit by name, map, shim ───────────────────────────────────────────────────────────
describe('the driver: entries emitted by name, mapped, and shimmed', () => {
	let root = '';
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-entry-emit-'));
		const files: Record<string, string> = {
			'src/routes/+layout.ts': 'export const csr = false;\n',
			'src/routes/+page.svelte': `<script>\n\timport Widget from '$lib/Widget.svelte' with { wake: 'visible' };\n\timport Chart from '$lib/Chart.svelte' with { wake: 'idle' };\n</script>\n<Widget /><Chart />\n`,
			'src/lib/Widget.svelte': `<p>w</p>\n`,
			'src/lib/Chart.svelte': `<p>c</p>\n`
		};
		for (const [rel, src] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), src);
		}
	});
	afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

	const make = () => {
		const program = new Program({ forms: true, router: true });
		const compiler = new Compiler(program, { prof: { transformMs: 0, transformN: 0, transformHit: 0, prescanMs: 0, bakeMs: 0, bakeN: 0, resolveMs: 0, loadMs: 0 }, P: false, outHash: new Map() });
		compiler.configure(
			new CompileCtx({
				root,
				base: '/',
				app_dir: '_app',
				runtime_hash: '0123456789ab',
				libDir: path.join(root, 'src/lib'),
				is_dev: false,
				id_salt: '',
				visibleMargin: '0px',
				presets: {},
				import_keys: normalize_import_keys(undefined),
				resolve_alias: [],
				markdown_config: null,
				pkg_root: '/nowhere/ogygia',
				app_shims: { '$app/state': '/x/a.js', '$app/stores': '/x/b.js', '$app/navigation': '/x/c.js' }
			})
		);
		compiler.prescan();
		return compiler;
	};
	const fake_emit = () => {
		const emitted: { id: string; name?: string; fileName?: string }[] = [];
		return { emitted, emit: (c: { id: string; name?: string; fileName?: string }) => (emitted.push(c), `ref${emitted.length}`) };
	};

	it('every island and the runtime are emitted by NAME (hashed by the bundler), never a fixed file name', () => {
		const compiler = make();
		const { emitted, emit } = fake_emit();
		compiler.emit_build_chunks(emit, { emitRuntime: true });
		expect(emitted.length).toBe(3);
		expect(emitted.every((c) => c.name && !c.fileName)).toBe(true);
		expect(emitted.filter((c) => c.name!.startsWith('og-region.')).length).toBe(2);
		expect(emitted.some((c) => c.name === 'og-runtime' || c.name!.startsWith('og-runtime-'))).toBe(true);
	});
	it('our entries get a readable, content-hashed file name; every other chunk keeps the app’s naming', () => {
		const compiler = make();
		expect(compiler.entry_file_pattern('og-region.0123456789ab')).toBe('_app/immutable/[name].[hash].js');
		expect(compiler.entry_file_pattern('og-runtime')).toBe('_app/immutable/[name].[hash].js');
		expect(compiler.entry_file_pattern('og-runtime-4b029c13h')).toBe('_app/immutable/[name].[hash].js');
		for (const other of ['index', 'og-regionx', 'og-runtimeish', 'chunk', '', undefined]) expect(compiler.entry_file_pattern(other)).toBeNull();
	});
	it('the runtime’s file names its features, like its stable name does', () => {
		const compiler = make();
		const { emitted, emit } = fake_emit();
		compiler.emit_build_chunks(emit, { emitRuntime: true });
		const runtime = emitted.find((c) => c.name!.startsWith('og-runtime'))!;
		const stable = compiler.runtime_chunk_filename();
		// the stable name: `…/og-runtime.<hash>[-<features>].js`
		const tail = stable.slice(stable.lastIndexOf('/og-runtime.') + '/og-runtime.'.length, -'.js'.length);
		const feat = tail.includes('-') ? tail.slice(tail.indexOf('-') + 1) : '';
		expect(runtime.name).toBe(feat ? `og-runtime-${feat}` : 'og-runtime');
	});
	it('identity → location for each, from the bundler’s final names', () => {
		const compiler = make();
		const { emit } = fake_emit();
		compiler.emit_build_chunks(emit, { emitRuntime: true });
		const names: Record<string, string> = { ref1: '_app/immutable/chunks/Rt.js', ref2: '_app/immutable/chunks/W.js', ref3: '_app/immutable/chunks/C.js' };
		const e = compiler.entry_locations((ref: string) => names[ref]);
		expect(Object.keys(e.locations).length).toBe(3);
		for (const [identity, location] of Object.entries(e.locations)) {
			expect(identity).toMatch(/^\/_app\/immutable\/og-(region\.[0-9a-f]{12}|runtime\.[\w-]+)\.js$/);
			expect(location).toMatch(/^\/_app\/immutable\/chunks\/\w+\.js$/);
		}
		expect(e.runtime_file).toBe('_app/immutable/chunks/Rt.js');
		expect(e.locations[e.runtime!]).toBe('/_app/immutable/chunks/Rt.js');
		expect([...e.islands.keys()].sort()).toEqual(['_app/immutable/chunks/C.js', '_app/immutable/chunks/W.js']);
	});
	it('a shim per entry at its stable name, re-exporting its location', () => {
		const compiler = make();
		const { emit } = fake_emit();
		compiler.emit_build_chunks(emit, { emitRuntime: true });
		const shims = compiler.entry_shims((ref: string) => `_app/immutable/chunks/${ref}.js`);
		expect(shims.length).toBe(3);
		for (const s of shims) {
			expect(s.fileName).toMatch(/^_app\/immutable\/og-(region|runtime)\./);
			expect(s.source).toMatch(/"\.\/chunks\/ref\d\.js"/);
		}
	});
	it('no runtime emitted → no runtime location, no runtime shim; a second emit starts clean', () => {
		const compiler = make();
		const first = fake_emit();
		compiler.emit_build_chunks(first.emit, { emitRuntime: true });
		const program_reset = make();
		const { emitted, emit } = fake_emit();
		program_reset.emit_build_chunks(emit, { emitRuntime: false });
		expect(emitted.length).toBe(2);
		const e = program_reset.entry_locations((ref: string) => `x/${ref}.js`);
		expect(e.runtime).toBeNull();
		expect(program_reset.entry_shims((ref: string) => `x/${ref}.js`).some((s: { fileName: string }) => s.fileName.includes('og-runtime'))).toBe(false);
	});
});
