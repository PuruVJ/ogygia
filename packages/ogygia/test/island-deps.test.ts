import { describe, expect, test } from 'vitest';
import {
	collectIslandDepModulepreloads,
	collect_inline_css,
	interactivity_facts,
	islandDepsHandoffPath,
	island_deps_module,
	kit_remote_hash,
	remote_hash_of
} from '../dist/compiler/link/island-deps.js';

const FACADE = '/_app/immutable/og-region.aaaaaaaaaaaa.js';
const ISLAND_REMOTES_FN_RE = /export function islandRemotes\(_?entry\)\s*\{([^}]*)\}/;

describe('collectIslandDepModulepreloads', () => {
	test('walks transitive static imports for og-region facades', () => {
		const bundle = {
			'_app/immutable/og-region.abc123def456.js': {
				type: 'chunk',
				fileName: '_app/immutable/og-region.abc123def456.js',
				imports: ['_app/immutable/chunk-shared-aaaa.js']
			},
			'_app/immutable/chunk-shared-aaaa.js': {
				type: 'chunk',
				fileName: '_app/immutable/chunk-shared-aaaa.js',
				imports: ['_app/immutable/chunk-leaf-bbbb.js']
			},
			'_app/immutable/chunk-leaf-bbbb.js': {
				type: 'chunk',
				fileName: '_app/immutable/chunk-leaf-bbbb.js',
				imports: []
			},
			'_app/immutable/og-region.deadbeef0001.js': {
				type: 'chunk',
				fileName: '_app/immutable/og-region.deadbeef0001.js',
				imports: ['_app/immutable/chunk-shared-aaaa.js']
			},
			'_app/immutable/unrelated-entry.js': {
				type: 'chunk',
				fileName: '_app/immutable/unrelated-entry.js',
				imports: ['_app/immutable/chunk-leaf-bbbb.js']
			}
		};

		const { js } = collectIslandDepModulepreloads(bundle);
		expect(js['/_app/immutable/og-region.abc123def456.js']).toEqual([
			'/_app/immutable/chunk-shared-aaaa.js',
			'/_app/immutable/chunk-leaf-bbbb.js'
		]);
		expect(js['/_app/immutable/og-region.deadbeef0001.js']).toEqual([
			'/_app/immutable/chunk-shared-aaaa.js',
			'/_app/immutable/chunk-leaf-bbbb.js'
		]);
		expect(js['/_app/immutable/unrelated-entry.js']).toBeUndefined();
	});

	test('dedupes cycles and skips the facade itself', () => {
		const facade = '_app/immutable/og-region.ffffffffffff.js';
		const bundle = {
			[facade]: {
				type: 'chunk',
				fileName: facade,
				imports: ['_app/immutable/a.js', facade]
			},
			'_app/immutable/a.js': {
				type: 'chunk',
				fileName: '_app/immutable/a.js',
				imports: ['_app/immutable/b.js']
			},
			'_app/immutable/b.js': {
				type: 'chunk',
				fileName: '_app/immutable/b.js',
				imports: ['_app/immutable/a.js']
			}
		};
		expect(collectIslandDepModulepreloads(bundle).js['/' + facade]).toEqual([
			'/_app/immutable/a.js',
			'/_app/immutable/b.js'
		]);
	});

	test('ignores assets and non-island chunks', () => {
		expect(
			collectIslandDepModulepreloads({
				'_app/immutable/foo.css': { type: 'asset', fileName: '_app/immutable/foo.css' },
				'_app/immutable/og-runtime.abcdef123456.js': {
					type: 'chunk',
					fileName: '_app/immutable/og-runtime.abcdef123456.js',
					imports: ['_app/immutable/x.js']
				}
			})
		).toEqual({ js: {}, css: {}, page: {}, page_keys: {}, remotes: {}, interactivity: {} });
	});

	// INTERACTIVITY FACTS (the profiler's wake advisor): counted over the island's OWN components
	// in its closure, each file once, dependencies and ogygia's own wrappers skipped; without a
	// source reader the map stays empty (the handoff is byte-stable for builds that never ask).
	describe('interactivity', () => {
		const SRC: Record<string, string> = {
			'/app/src/lib/Card.svelte':
				'<script>let n = $state(0); let el; $effect(() => {});</script>' +
				'<button onclick={() => n++} bind:this={el} use:tip>{n}</button><input on:input={f}>',
			'/app/src/lib/Static.svelte': '<h1>{title}</h1>',
			'/app/node_modules/lib/Widget.svelte': '<button onclick={x}>dep</button>'
		};
		const bundle = {
			[FACADE.slice(1)]: {
				type: 'chunk',
				fileName: FACADE.slice(1),
				imports: ['_app/immutable/chunk-a.js'],
				moduleIds: ['/app/src/lib/Card.svelte', '/app/src/lib/Card.svelte?og-region=x']
			},
			'_app/immutable/chunk-a.js': {
				type: 'chunk',
				fileName: '_app/immutable/chunk-a.js',
				imports: [],
				moduleIds: ['/app/src/lib/Static.svelte', '/app/node_modules/lib/Widget.svelte', '/app/src/lib/util.js']
			}
		};
		const read = (id: string) => SRC[id] ?? null;

		test('counts handlers / state / effects / binds / actions across the closure, one file once', () => {
			expect(interactivity_facts(SRC['/app/src/lib/Card.svelte'])).toEqual({
				handlers: 2,
				state: 1,
				effects: 1,
				binds: 1,
				actions: 1,
				files: 1
			});
			const { interactivity } = collectIslandDepModulepreloads(bundle, undefined, undefined, undefined, read);
			expect(interactivity[FACADE]).toEqual({ handlers: 2, state: 1, effects: 1, binds: 1, actions: 1, files: 2 });
		});

		test('no reader → no facts; a pure-markup island reads as zero everywhere', () => {
			expect(collectIslandDepModulepreloads(bundle).interactivity).toEqual({});
			const only_static = {
				[FACADE.slice(1)]: { type: 'chunk', fileName: FACADE.slice(1), imports: [], moduleIds: ['/app/src/lib/Static.svelte'] }
			};
			expect(collectIslandDepModulepreloads(only_static, undefined, undefined, undefined, read).interactivity[FACADE]).toEqual({
				handlers: 0,
				state: 0,
				effects: 0,
				binds: 0,
				actions: 0,
				files: 1
			});
		});
	});

	// `page[entry]` — does the island's chunk closure bundle a page-reading shim? Decides whether the
	// handle ships the page seed (Region.svelte → `islandReadsPage`).
	describe('page-reader map', () => {
		const SHIM = '/pkg/shims/app-state.svelte.js';
		const bundle = (facade_ids: string[], dep_ids: string[]) => ({
			'_app/immutable/og-region.aaaaaaaaaaaa.js': {
				type: 'chunk',
				fileName: '_app/immutable/og-region.aaaaaaaaaaaa.js',
				imports: ['_app/immutable/chunks/dep.js'],
				moduleIds: facade_ids
			},
			'_app/immutable/chunks/dep.js': {
				type: 'chunk',
				fileName: '_app/immutable/chunks/dep.js',
				imports: [],
				moduleIds: dep_ids
			}
		});
		test('shim in the facade itself → reads', () => {
			const r = collectIslandDepModulepreloads(bundle([SHIM, '/app/src/lib/A.svelte'], []), [SHIM]);
			expect(r.page['/_app/immutable/og-region.aaaaaaaaaaaa.js']).toBe(true);
		});
		test('shim in a transitive dep chunk → reads', () => {
			const r = collectIslandDepModulepreloads(bundle(['/app/src/lib/A.svelte'], [SHIM]), [SHIM]);
			expect(r.page['/_app/immutable/og-region.aaaaaaaaaaaa.js']).toBe(true);
		});
		test('no shim anywhere in the closure → does not read (false, present in the map)', () => {
			const r = collectIslandDepModulepreloads(
				bundle(['/app/src/lib/A.svelte'], ['/app/src/lib/B.svelte']),
				[SHIM]
			);
			expect(r.page['/_app/immutable/og-region.aaaaaaaaaaaa.js']).toBe(false);
		});
		test('module ids with a query suffix or Windows separators still match', () => {
			const r = collectIslandDepModulepreloads(
				bundle(['C:\\pkg\\shims\\app-state.svelte.js?og-region'], []),
				['C:/pkg/shims/app-state.svelte.js']
			);
			expect(r.page['/_app/immutable/og-region.aaaaaaaaaaaa.js']).toBe(true);
		});
		test('no reader files given → every entry false (the map still lists it)', () => {
			const r = collectIslandDepModulepreloads(bundle([SHIM], [SHIM]));
			expect(r.page['/_app/immutable/og-region.aaaaaaaaaaaa.js']).toBe(false);
		});
	});

	// SEED SHAPING — `page_keys[entry]`: the union of the `page.data` keys every module in the
	// closure reads (the transform's per-module answer), or null = ship all.
	describe('page-keys map', () => {
		const SHIM = '/pkg/shims/app-state.svelte.js';
		const ENTRY = '/_app/immutable/og-region.aaaaaaaaaaaa.js';
		const bundle = (facade_ids: string[], dep_ids: string[]) => ({
			'_app/immutable/og-region.aaaaaaaaaaaa.js': { type: 'chunk', fileName: '_app/immutable/og-region.aaaaaaaaaaaa.js', imports: ['_app/immutable/chunks/dep.js'], moduleIds: facade_ids },
			'_app/immutable/chunks/dep.js': { type: 'chunk', fileName: '_app/immutable/chunks/dep.js', imports: [], moduleIds: dep_ids }
		});
		const keys_of = (table: Record<string, Set<string> | 'all'>) => (id: string) => table[id] ?? null;

		test('keys union across the facade and a dep chunk, sorted', () => {
			const r = collectIslandDepModulepreloads(
				bundle([SHIM, '/app/src/lib/A.svelte'], ['/app/src/lib/util.ts']),
				[SHIM],
				null,
				keys_of({ '/app/src/lib/A.svelte': new Set(['user', '_locale']), '/app/src/lib/util.ts': new Set(['flags']) })
			);
			expect(r.page[ENTRY]).toBe(true);
			expect(r.page_keys[ENTRY]).toEqual(['_locale', 'flags', 'user']);
		});
		test('one unpinned module → null (ship all)', () => {
			const r = collectIslandDepModulepreloads(
				bundle([SHIM, '/app/src/lib/A.svelte'], ['/app/src/lib/util.ts']),
				[SHIM],
				null,
				keys_of({ '/app/src/lib/A.svelte': new Set(['user']), '/app/src/lib/util.ts': 'all' })
			);
			expect(r.page_keys[ENTRY]).toBeNull();
		});
		test('a reader whose keys no module recorded → null (the page reached through unseen code)', () => {
			const r = collectIslandDepModulepreloads(bundle([SHIM, '/app/src/lib/A.svelte'], []), [SHIM], null, keys_of({}));
			expect(r.page[ENTRY]).toBe(true);
			expect(r.page_keys[ENTRY]).toBeNull();
		});
		test('a non-reader has no page_keys entry; query suffixes are stripped for the lookup', () => {
			const r = collectIslandDepModulepreloads(
				bundle(['/app/src/lib/A.svelte?og-region'], ['/app/src/lib/B.svelte']),
				[SHIM],
				null,
				keys_of({ '/app/src/lib/A.svelte': new Set(['x']) })
			);
			expect(r.page[ENTRY]).toBe(false);
			expect(ENTRY in r.page_keys).toBe(false);
		});
	});

	test('collects CSS from the facade + dep chunks (viteMetadata.importedCss)', () => {
		const facade = '_app/immutable/og-region.c55beef00001.js';
		const bundle = {
			[facade]: {
				type: 'chunk',
				fileName: facade,
				imports: ['_app/immutable/dep.js'],
				viteMetadata: { importedCss: new Set(['_app/immutable/card.abcd.css']) }
			},
			'_app/immutable/dep.js': {
				type: 'chunk',
				fileName: '_app/immutable/dep.js',
				imports: [],
				viteMetadata: { importedCss: new Set(['_app/immutable/shared.ef01.css']) }
			}
		};
		expect(collectIslandDepModulepreloads(bundle).css['/' + facade]).toEqual([
			'/_app/immutable/card.abcd.css',
			'/_app/immutable/shared.ef01.css'
		]);
	});
});

// REMOTE SEED ONLY WHEN REACHABLE — per facade, the Kit remote modules anywhere in its chunk
// closure (static + dynamic), named by the id-hash Kit mints them with, so the handle can seed an
// SSR-resolved remote only for a page with an island that can call it.
describe('remotes map', () => {
	const CWD = '/app';
	const hash_of = (id: string) => remote_hash_of(id, CWD);
	const FOOTER = '/app/src/lib/footer.remote.ts';
	const SESSION = '/app/src/lib/session.remote.js';
	const chunk = (
		fileName: string,
		moduleIds: string[],
		imports: string[] = [],
		dynamicImports: string[] = []
	) => ({ type: 'chunk', fileName, moduleIds, imports, dynamicImports });
	const facade = (moduleIds: string[], imports: string[] = [], dynamicImports: string[] = []) =>
		chunk('_app/immutable/og-region.aaaaaaaaaaaa.js', moduleIds, imports, dynamicImports);
	const bundle = (chunks: ReturnType<typeof chunk>[]) =>
		Object.fromEntries(chunks.map((c) => [c.fileName, c]));

	describe('kit_remote_hash / remote_hash_of — Kit parity', () => {
		test('vectors observed on a real Kit build (`internals.id` = `${hash}/${name}`)', () => {
			// `src/lib/footer-v2/footer.remote.ts` → `1rczqrp/footerProps`; `src/lib/greetings.remote.ts`
			// → `bjveep/getGreeting` — both read off `<script type="application/ogygia-remote">` seeds.
			expect(kit_remote_hash('src/lib/footer-v2/footer.remote.ts')).toBe('1rczqrp');
			expect(kit_remote_hash('src/lib/greetings.remote.ts')).toBe('bjveep');
		});
		test('a remote module id hashes by its path relative to cwd, posix', () => {
			expect(remote_hash_of('/app/src/lib/footer-v2/footer.remote.ts', '/app')).toBe('1rczqrp');
			expect(remote_hash_of('/app/src/lib/footer-v2/footer.remote.ts', '/app/')).toBe('1rczqrp');
		});
		test('a `?query` suffix and Windows separators do not change the hash', () => {
			expect(remote_hash_of('/app/src/lib/footer-v2/footer.remote.ts?og-region', '/app')).toBe('1rczqrp');
			expect(remote_hash_of('C:\\app\\src\\lib\\footer-v2\\footer.remote.ts', 'C:\\app')).toBe('1rczqrp');
		});
		test('.remote.js / .mjs / .cjs / .mts count; anything else is not a remote', () => {
			expect(remote_hash_of('/app/src/x.remote.js', '/app')).toBe(kit_remote_hash('src/x.remote.js'));
			expect(remote_hash_of('/app/src/x.remote.mts', '/app')).toBe(kit_remote_hash('src/x.remote.mts'));
			expect(remote_hash_of('/app/src/x.remote.cjs', '/app')).toBe(kit_remote_hash('src/x.remote.cjs'));
			expect(remote_hash_of('/app/src/x.svelte', '/app')).toBeNull();
			expect(remote_hash_of('/app/src/remote.ts', '/app')).toBeNull();
			expect(remote_hash_of('/app/src/x.remote.ts.bak', '/app')).toBeNull();
		});
	});

	test('remote in the facade itself → listed', () => {
		const r = collectIslandDepModulepreloads(bundle([facade([FOOTER, '/app/src/lib/A.svelte'])]), [], hash_of);
		expect(r.remotes[FACADE]).toEqual([kit_remote_hash('src/lib/footer.remote.ts')]);
	});
	test('remote in a transitive STATIC dep chunk → listed', () => {
		const b = bundle([
			facade(['/app/src/lib/A.svelte'], ['_app/immutable/chunks/dep.js']),
			chunk('_app/immutable/chunks/dep.js', ['/app/src/lib/B.svelte'], ['_app/immutable/chunks/leaf.js']),
			chunk('_app/immutable/chunks/leaf.js', [FOOTER])
		]);
		expect(collectIslandDepModulepreloads(b, [], hash_of).remotes[FACADE]).toEqual([
			kit_remote_hash('src/lib/footer.remote.ts')
		]);
	});
	test('remote behind a DYNAMIC import → listed (still this island\u2019s call), not preloaded', () => {
		const b = bundle([
			facade(['/app/src/lib/A.svelte'], [], ['_app/immutable/chunks/lazy.js']),
			chunk('_app/immutable/chunks/lazy.js', [FOOTER])
		]);
		const r = collectIslandDepModulepreloads(b, [], hash_of);
		expect(r.remotes[FACADE]).toEqual([kit_remote_hash('src/lib/footer.remote.ts')]);
		expect(r.js[FACADE]).toEqual([]); // the preload walk stays static-only
	});
	test('no remote anywhere in the closure → [] (present in the map: a known entry that calls nothing)', () => {
		const b = bundle([
			facade(['/app/src/lib/A.svelte'], ['_app/immutable/chunks/dep.js']),
			chunk('_app/immutable/chunks/dep.js', ['/app/src/lib/B.svelte'])
		]);
		const r = collectIslandDepModulepreloads(b, [], hash_of);
		expect(r.remotes[FACADE]).toEqual([]);
		expect(Object.keys(r.remotes)).toEqual([FACADE]);
	});
	test('several remotes → every one, deduped and sorted (byte-stable handoff)', () => {
		const b = bundle([
			facade([SESSION, FOOTER], ['_app/immutable/chunks/dep.js']),
			chunk('_app/immutable/chunks/dep.js', [FOOTER + '?og-region', SESSION])
		]);
		const r = collectIslandDepModulepreloads(b, [], hash_of);
		expect(r.remotes[FACADE]).toEqual(
			[kit_remote_hash('src/lib/footer.remote.ts'), kit_remote_hash('src/lib/session.remote.js')].sort()
		);
	});
	test('a phantom (non-emitted) import is skipped, a cycle terminates', () => {
		const b = bundle([
			facade([FOOTER], ['_app/immutable/chunks/gone.js', '_app/immutable/chunks/a.js']),
			chunk('_app/immutable/chunks/a.js', [], ['_app/immutable/chunks/b.js']),
			chunk('_app/immutable/chunks/b.js', [SESSION], ['_app/immutable/chunks/a.js'])
		]);
		const r = collectIslandDepModulepreloads(b, [], hash_of);
		expect(r.remotes[FACADE]).toEqual(
			[kit_remote_hash('src/lib/footer.remote.ts'), kit_remote_hash('src/lib/session.remote.js')].sort()
		);
	});
	test('no resolver given → every entry [] (the map still lists it)', () => {
		const r = collectIslandDepModulepreloads(bundle([facade([FOOTER])]));
		expect(r.remotes[FACADE]).toEqual([]);
	});
	test('a non-island chunk that imports a remote adds nothing to any island', () => {
		const b = bundle([
			facade(['/app/src/lib/A.svelte']),
			chunk('_app/immutable/entry/app.js', [FOOTER])
		]);
		expect(collectIslandDepModulepreloads(b, [], hash_of).remotes[FACADE]).toEqual([]);
	});

	test('at scale: 3 000 chunks, 300 facades, 60 remote modules, shared + dynamic + cyclic edges \u2014 exact vs a naive reference, fast', () => {
		// Deterministic LCG so a failure reproduces.
		let s = 20260914;
		const rnd = (n: number) => ((s = (s * 1664525 + 1013904223) >>> 0) % n);
		const N = 3000;
		const files = Array.from({ length: N }, (_, i) =>
			i < 300 ? `_app/immutable/og-region.${i.toString(16).padStart(12, '0')}.js` : `_app/immutable/chunks/c${i}.js`
		);
		const remote_files = Array.from({ length: 60 }, (_, i) => `/app/src/lib/r${i}.remote.ts`);
		const b: Record<string, ReturnType<typeof chunk>> = {};
		for (let i = 0; i < N; i++) {
			const imports: string[] = [];
			const dyn: string[] = [];
			const fan = rnd(4);
			for (let k = 0; k < fan; k++) (rnd(3) === 0 ? dyn : imports).push(files[rnd(N)]);
			if (rnd(50) === 0) imports.push('_app/immutable/chunks/phantom.js'); // not emitted
			const mods = [`/app/src/lib/m${i}.svelte`];
			if (rnd(6) === 0) mods.push(remote_files[rnd(60)] + (rnd(2) ? '?og-region' : ''));
			b[files[i]] = chunk(files[i], mods, imports, dyn);
		}
		// naive reference: BFS over imports + dynamicImports, collect remote hashes
		const reference = (start: string): string[] => {
			const seen = new Set([start]);
			const q = [start];
			const out = new Set<string>();
			while (q.length) {
				const f = q.shift()!;
				const c = b[f];
				if (!c) continue;
				for (const id of c.moduleIds) {
					const h = hash_of(id);
					if (h) out.add(h);
				}
				for (const n of [...c.imports, ...c.dynamicImports]) if (b[n] && !seen.has(n)) (seen.add(n), q.push(n));
			}
			return [...out].sort();
		};
		const t0 = performance.now();
		const r = collectIslandDepModulepreloads(b, [], hash_of);
		const ms = performance.now() - t0;
		expect(Object.keys(r.remotes).length).toBe(300);
		for (let i = 0; i < 300; i++) expect(r.remotes['/' + files[i]]).toEqual(reference(files[i]));
		expect(ms).toBeLessThan(2000);
		// and the static-only preload walk never lists a dynamic-only chunk
		for (let i = 0; i < 300; i++) for (const d of r.js['/' + files[i]]) expect(b[d.slice(1)].type).toBe('chunk');
	});

	describe('the virtual module\u2019s islandRemotes', () => {
		test('client leg → null (unused there)', () => {
			const m = ISLAND_REMOTES_FN_RE.exec(island_deps_module(false, false));
			expect(m?.[1]).toContain('return null');
		});
		test('dev → null (fail-open: no chunk closure to consult)', () => {
			const m = ISLAND_REMOTES_FN_RE.exec(island_deps_module(true, true));
			expect(m?.[1]).toContain('return null');
		});
		test('prod SSR → reads the handoff\u2019s `remotes` map, null for a missing map or unknown entry', () => {
			const src = island_deps_module(true, false);
			expect(src).toContain('all.remotes');
			expect(src).toContain('export function islandRemotes(entry)');
			expect(src).toContain('return Array.isArray(v) ? v : null');
		});
	});
});

// INLINE REGION CSS: the text of region sheets under Kit's `inlineStyleThreshold`, keyed by href.
describe('collect_inline_css', () => {
	const bundle = {
		'_app/immutable/assets/Tiny.abc.css': { type: 'asset', fileName: '_app/immutable/assets/Tiny.abc.css', source: '.t{color:red}' },
		'_app/immutable/assets/Big.def.css': { type: 'asset', fileName: '_app/immutable/assets/Big.def.css', source: '.b{' + 'x'.repeat(600) + '}' },
		'_app/immutable/assets/Bytes.ghi.css': { type: 'asset', fileName: '_app/immutable/assets/Bytes.ghi.css', source: new TextEncoder().encode('.u{content:"é"}') },
		'_app/immutable/assets/Closes.jkl.css': { type: 'asset', fileName: '_app/immutable/assets/Closes.jkl.css', source: '.c{content:"</style>"}' },
		'_app/immutable/og-region.aaaaaaaaaaaa.js': { type: 'chunk', fileName: '_app/immutable/og-region.aaaaaaaaaaaa.js' }
	};
	const hrefs = [
		'/_app/immutable/assets/Tiny.abc.css',
		'/_app/immutable/assets/Big.def.css',
		'/_app/immutable/assets/Bytes.ghi.css',
		'/_app/immutable/assets/Closes.jkl.css',
		'/_app/immutable/assets/Missing.css',
		'/_app/immutable/og-region.aaaaaaaaaaaa.js'
	];

	test('keeps the text of sheets under the threshold, keyed by their public href', () => {
		const out = collect_inline_css(bundle, hrefs, 400);
		expect(out).toEqual({
			'/_app/immutable/assets/Tiny.abc.css': '.t{color:red}',
			'/_app/immutable/assets/Bytes.ghi.css': '.u{content:"é"}'
		});
	});

	test('over the threshold, not an asset, missing, or able to close its own <style>: linked, not inlined', () => {
		const out = collect_inline_css(bundle, hrefs, 400);
		expect(out).not.toHaveProperty('/_app/immutable/assets/Big.def.css');
		expect(out).not.toHaveProperty('/_app/immutable/og-region.aaaaaaaaaaaa.js');
		expect(out).not.toHaveProperty('/_app/immutable/assets/Missing.css');
		expect(out).not.toHaveProperty('/_app/immutable/assets/Closes.jkl.css');
	});

	test('the threshold is Kit’s unit (String.length, strictly smaller), and 0 / absent means never inline', () => {
		// '.u{content:"é"}' is 15 code units (16 bytes — bytes are NOT the unit)
		expect(collect_inline_css(bundle, hrefs, 15)).not.toHaveProperty('/_app/immutable/assets/Bytes.ghi.css');
		expect(collect_inline_css(bundle, hrefs, 16)).toHaveProperty('/_app/immutable/assets/Bytes.ghi.css');
		expect(collect_inline_css(bundle, hrefs, 0)).toEqual({});
		expect(collect_inline_css(bundle, hrefs, Number.NaN)).toEqual({});
	});

	test('the virtual module exposes islandCssInline on every leg (null where nothing is kept)', () => {
		for (const src of [island_deps_module(false, false), island_deps_module(true, true), island_deps_module(true, false)]) {
			expect(src).toContain('export function islandCssInline(');
		}
		expect(island_deps_module(true, false)).toContain("all.css_inline");
	});
});

describe('islandDepsHandoffPath', () => {
	test('is under Kit outDir (`.svelte-kit` by default, whatever the app configured otherwise)', () => {
		expect(islandDepsHandoffPath('/app/.svelte-kit')).toBe('/app/.svelte-kit/og-region-deps.json');
		expect(islandDepsHandoffPath('/app/.svelte-kit-v2')).toBe('/app/.svelte-kit-v2/og-region-deps.json');
	});
});
