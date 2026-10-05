// An inline island a Kit client navigation created has no component yet. Region renders
// LateIsland.svelte, which loads it and draws it when it lands; where the app runs Svelte's async
// mode, the plugin points that import at LateIslandAwait.svelte, which awaits the load so the
// navigation keeps the old page until the island is in. Without async mode the awaiting one does
// not compile — so it is never the default.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { late_island_redirect, svelte_async_enabled, LATE_ISLAND_IMPORT } from '../src/vite/late-island.js';

const read = (f: string) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8');

describe('LateIsland', () => {
	it('Region imports the plain one, by the path the plugin redirects', () => {
		expect(read('Region.svelte')).toContain(`import LateIsland from '${LATE_ISLAND_IMPORT}';`);
	});

	it('the plain one compiles without async mode; the awaiting one needs it', () => {
		for (const generate of ['client', 'server'] as const) {
			expect(() => compile(read('LateIsland.svelte'), { filename: 'LateIsland.svelte', generate })).not.toThrow();
			expect(() => compile(read('LateIslandAwait.svelte'), { filename: 'LateIslandAwait.svelte', generate, experimental: { async: true } })).not.toThrow();
		}
		expect(() => compile(read('LateIslandAwait.svelte'), { filename: 'LateIslandAwait.svelte', generate: 'client' })).toThrow();
	});

	it('the redirect: only Region’s LateIsland import, to the awaiting file beside that copy of Region', () => {
		const regions = new Set(['/pkg/src/Region.svelte', '/pkg/dist/Region.svelte']);
		expect(late_island_redirect(LATE_ISLAND_IMPORT, '/pkg/src/Region.svelte', regions)).toBe('/pkg/src/LateIslandAwait.svelte');
		expect(late_island_redirect(LATE_ISLAND_IMPORT, '/pkg/dist/Region.svelte', regions)).toBe('/pkg/dist/LateIslandAwait.svelte');
		// another importer of a file by the same name, another import, no importer: untouched
		expect(late_island_redirect(LATE_ISLAND_IMPORT, '/app/src/Thing.svelte', regions)).toBeNull();
		expect(late_island_redirect('./Other.svelte', '/pkg/src/Region.svelte', regions)).toBeNull();
		expect(late_island_redirect(LATE_ISLAND_IMPORT, undefined, regions)).toBeNull();
	});

	it('async mode is read off vite-plugin-svelte’s resolved options', () => {
		const vps = (async?: boolean) => [{ name: 'other' }, { name: 'vite-plugin-svelte:config', api: { options: { compilerOptions: async === undefined ? {} : { experimental: { async } } } } }];
		expect(svelte_async_enabled(vps(true))).toBe(true);
		expect(svelte_async_enabled(vps(false))).toBe(false);
		expect(svelte_async_enabled(vps())).toBe(false);
		expect(svelte_async_enabled([{ name: 'other' }])).toBe(false);
	});
});
