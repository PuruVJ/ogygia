import { describe, expect, test } from 'vitest';
import {
	collectIslandDepModulepreloads,
	islandDepsHandoffPath
} from '../dist/vite/index.js';

describe('collectIslandDepModulepreloads', () => {
	test('walks transitive static imports for ogygia-island facades', () => {
		const bundle = {
			'_app/immutable/ogygia-island.abc123def456.js': {
				type: 'chunk',
				fileName: '_app/immutable/ogygia-island.abc123def456.js',
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
			'_app/immutable/ogygia-island.deadbeef0001.js': {
				type: 'chunk',
				fileName: '_app/immutable/ogygia-island.deadbeef0001.js',
				imports: ['_app/immutable/chunk-shared-aaaa.js']
			},
			'_app/immutable/unrelated-entry.js': {
				type: 'chunk',
				fileName: '_app/immutable/unrelated-entry.js',
				imports: ['_app/immutable/chunk-leaf-bbbb.js']
			}
		};

		const { js } = collectIslandDepModulepreloads(bundle);
		expect(js['/_app/immutable/ogygia-island.abc123def456.js']).toEqual([
			'/_app/immutable/chunk-shared-aaaa.js',
			'/_app/immutable/chunk-leaf-bbbb.js'
		]);
		expect(js['/_app/immutable/ogygia-island.deadbeef0001.js']).toEqual([
			'/_app/immutable/chunk-shared-aaaa.js',
			'/_app/immutable/chunk-leaf-bbbb.js'
		]);
		expect(js['/_app/immutable/unrelated-entry.js']).toBeUndefined();
	});

	test('dedupes cycles and skips the facade itself', () => {
		const facade = '_app/immutable/ogygia-island.ffffffffffff.js';
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
				'_app/immutable/ogygia-runtime.abcdef123456.js': {
					type: 'chunk',
					fileName: '_app/immutable/ogygia-runtime.abcdef123456.js',
					imports: ['_app/immutable/x.js']
				}
			})
		).toEqual({ js: {}, css: {} });
	});

	test('collects CSS from the facade + dep chunks (viteMetadata.importedCss)', () => {
		const facade = '_app/immutable/ogygia-island.c55beef00001.js';
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
	test('is under .svelte-kit at the app root', () => {
		expect(islandDepsHandoffPath('/app')).toBe('/app/.svelte-kit/ogygia-island-deps.json');
	});
});
