// ASYNC TWINS (vite/late-island.ts): Region imports a component that works anywhere; where the app runs
// Svelte's async mode, the plugin points that import at its awaiting twin — a late island loaded in one
// swap, a promise `of` awaited in the server render. Without async mode the awaiting one does not
// compile — so it is never the default.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { async_twin_redirect, svelte_async_enabled, ASYNC_TWINS } from '../src/vite/late-island.js';

const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');

describe('async twins', () => {
	it('Region imports each plain one, by the path the plugin redirects', () => {
		const region = read('Region.svelte');
		expect(region).toContain(`from './LateIsland.svelte';`);
		expect(region).toContain(`from './PromiseRegion.svelte';`);
		expect(Object.keys(ASYNC_TWINS)).toEqual(['./LateIsland.svelte', './PromiseRegion.svelte']);
	});

	it('each plain one compiles without async mode; each awaiting one needs it', () => {
		for (const [plain_import, twin] of Object.entries(ASYNC_TWINS)) {
			const plain = plain_import.slice(2);
			for (const generate of ['client', 'server'] as const) {
				expect(() => compile(read(plain), { filename: plain, generate })).not.toThrow();
				expect(() => compile(read(twin), { filename: twin, generate, experimental: { async: true } })).not.toThrow();
			}
			expect(() => compile(read(twin), { filename: twin, generate: 'client' })).toThrow();
		}
	});

	it('the redirect: only Region’s twin imports, to the awaiting file beside that copy of Region', () => {
		const regions = new Set(['/pkg/src/Region.svelte', '/pkg/dist/Region.svelte']);
		expect(async_twin_redirect('./LateIsland.svelte', '/pkg/src/Region.svelte', regions)).toBe('/pkg/src/LateIslandAwait.svelte');
		expect(async_twin_redirect('./PromiseRegion.svelte', '/pkg/dist/Region.svelte', regions)).toBe('/pkg/dist/PromiseRegionAwait.svelte');
		// another importer of a file by the same name, another import, no importer: untouched
		expect(async_twin_redirect('./LateIsland.svelte', '/app/src/Thing.svelte', regions)).toBeNull();
		expect(async_twin_redirect('./Other.svelte', '/pkg/src/Region.svelte', regions)).toBeNull();
		expect(async_twin_redirect('./PromiseRegion.svelte', undefined, regions)).toBeNull();
	});

	it('async mode is read off vite-plugin-svelte’s resolved options', () => {
		const vps = (async?: boolean) => [{ name: 'other' }, { name: 'vite-plugin-svelte:config', api: { options: { compilerOptions: async === undefined ? {} : { experimental: { async } } } } }];
		expect(svelte_async_enabled(vps(true))).toBe(true);
		expect(svelte_async_enabled(vps(false))).toBe(false);
		expect(svelte_async_enabled(vps())).toBe(false);
		expect(svelte_async_enabled([{ name: 'other' }])).toBe(false);
	});
});
