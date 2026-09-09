import { describe, expect, test } from 'vitest';
import {
	collectIslandDepModulepreloads,
	islandDepsHandoffPath
} from '../dist/compiler/link/island-deps.js';

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
		).toEqual({ js: {}, css: {}, page: {} });
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

describe('islandDepsHandoffPath', () => {
	test('is under Kit outDir (`.svelte-kit` by default, whatever the app configured otherwise)', () => {
		expect(islandDepsHandoffPath('/app/.svelte-kit')).toBe('/app/.svelte-kit/og-region-deps.json');
		expect(islandDepsHandoffPath('/app/.svelte-kit-v2')).toBe('/app/.svelte-kit-v2/og-region-deps.json');
	});
});
