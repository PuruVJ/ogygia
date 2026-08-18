// Island-world module identity (`?og-region`). Membership must travel IN the module id — the one
// channel the bundler dedups and schedules by — so the `$app/*` shim decision can never race
// module processing, and a component shared between a csr=true route and an island exists as two
// modules, each with the correct `$app/*` flavor. Regression for the production split brain: a
// Header island whose `$app/stores` import (line 2) bundled Kit's REAL client store — `$page.url`
// undefined at hydrate — while siblings imported on lines 32-34 got the shim, same build.

import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { ogygia, islandVirtualId } from '../dist/vite/index.js';
import { regionId, regionIdentity } from '../dist/compiler/transform.js';

const ROOT = '/nonexistent-ogygia-test-app';
// A lib component (not a route host): lib components always keep their islands.
const HOST = `${ROOT}/src/lib/Widget.svelte`;

type Hook<T> = T | { handler: T };
const handler = <T>(hook: Hook<T>): T =>
	(typeof hook === 'object' && hook !== null && 'handler' in (hook as object)
		? (hook as { handler: T }).handler
		: (hook as T));

function make_plugin(): Plugin {
	const plugin = ogygia().find((p) => p.name === 'ogygia')!;
	delete process.env.OGYGIA_SECRET;
	handler(plugin.configResolved!).call(null as never, {
		root: ROOT,
		base: '/',
		command: 'serve',
		mode: 'development',
		envDir: false,
		build: {}
	} as never);
	return plugin;
}

const rid = (plugin: Plugin) => handler(plugin.resolveId!);

describe('region-world identity (?og-region)', () => {
	it('a suffixed importer gets the `$app/*` shims on the client, real Kit modules on SSR', async () => {
		const plugin = make_plugin();
		const ctx = { resolve: async () => null };
		const importer = `${ROOT}/src/lib/Header.svelte?og-region`;
		for (const source of ['$app/stores', '$app/state', '$app/navigation']) {
			const res = await rid(plugin).call(ctx as never, source, importer, { ssr: false });
			expect(res, source).toMatch(/[\\/]shims[\\/]app-/);
		}
		// SSR keeps Kit's real modules (server-rendered page.data must be correct).
		const ssr = await rid(plugin).call(ctx as never, '$app/stores', importer, { ssr: true });
		expect(ssr).toBeNull();
	});

	it('propagates the suffix to resolved children, against the query-stripped importer', async () => {
		const plugin = make_plugin();
		const child = `${ROOT}/src/lib/format.ts`;
		const seen: Array<[string, string]> = [];
		const ctx = {
			resolve: async (source: string, importer: string) => {
				seen.push([source, importer]);
				return { id: child };
			}
		};
		const res = await rid(plugin).call(
			ctx as never,
			'./format',
			`${ROOT}/src/lib/Header.svelte?og-region`,
			{ ssr: false }
		);
		expect((res as { id: string }).id).toBe(`${child}?og-region`);
		// The inner resolution must see the real file path, not the suffixed id.
		expect(seen[0]).toEqual(['./format', `${ROOT}/src/lib/Header.svelte`]);
	});

	it('recognizes the suffix among other query params', async () => {
		const plugin = make_plugin();
		const child = `${ROOT}/src/lib/util.ts`;
		const ctx = { resolve: async () => ({ id: child }) };
		const res = await rid(plugin).call(
			ctx as never,
			'./util',
			`${ROOT}/src/lib/Header.svelte?v=123&og-region`,
			{ ssr: false }
		);
		expect((res as { id: string }).id).toBe(`${child}?og-region`);
	});

	it('shared-world leaves stay unsuffixed: svelte/Kit runtimes, prebundled deps, assets', async () => {
		const plugin = make_plugin();
		const importer = `${ROOT}/src/lib/Header.svelte?og-region`;
		for (const leaf of [
			`${ROOT}/node_modules/svelte/src/index-client.js`,
			`${ROOT}/node_modules/@sveltejs/kit/src/runtime/app/paths.js`,
			`${ROOT}/node_modules/.vite/deps/lodash-es.js`,
			`${ROOT}/src/app.css`,
			`${ROOT}/src/lib/logo.svg`,
			`${ROOT}/src/data.json`
		]) {
			const ctx = { resolve: async () => ({ id: leaf }) };
			const res = await rid(plugin).call(ctx as never, 'x', importer, { ssr: false });
			expect((res as { id: string }).id, leaf).toBe(leaf);
		}
	});

	it('node_modules packages DO get island identity (workspace libs import $app/*)', async () => {
		const plugin = make_plugin();
		const dep = `${ROOT}/node_modules/@acme/header-kit/dist/stores.js`;
		const ctx = { resolve: async () => ({ id: dep }) };
		const res = await rid(plugin).call(
			ctx as never,
			'@acme/header-kit/stores',
			`${ROOT}/src/lib/Header.svelte?og-region`,
			{ ssr: false }
		);
		expect((res as { id: string }).id).toBe(`${dep}?og-region`);
	});

	it('the suffix ENTERS the graph at the generated island module, client leg only', async () => {
		const plugin = make_plugin();
		const SPEC = 'some-pkg/tabs';
		const component = `${ROOT}/node_modules/some-pkg/dist/Tabs.svelte`;
		const ctx = { resolve: async () => ({ id: component }), emitFile: () => '' };
		const src = `<script>\nimport TabGroup from '${SPEC}' with { wake: 'load' };\n</script>\n<TabGroup />`;
		await handler(plugin.transform!).call(ctx as never, src, HOST, { ssr: true });
		const iid = regionId(regionIdentity(SPEC, { strategy: 'load', options: {} }));
		const entry = islandVirtualId(iid);
		const client = await rid(plugin).call(ctx as never, SPEC, entry, { ssr: false });
		expect((client as { id: string }).id).toBe(`${component}?og-region`);
		const ssr = await rid(plugin).call(ctx as never, SPEC, entry, { ssr: true });
		expect((ssr as { id: string }).id).toBe(component);
	});

	it('REGRESSION (split brain): plain-graph resolution first cannot poison the island copy', async () => {
		const plugin = make_plugin();
		const child = `${ROOT}/src/lib/shared/Deep.svelte`;
		const ctx = { resolve: async () => ({ id: child }) };
		// The Kit route graph reaches the file FIRST — the exact ordering that used to decide,
		// permanently and per-build-schedule, which `$app/*` the island would get. Ogygia must
		// stay out of the plain world entirely…
		const plain = await rid(plugin).call(
			ctx as never,
			'./shared/Deep.svelte',
			`${ROOT}/src/lib/Header.svelte`,
			{ ssr: false }
		);
		expect(plain).toBeNull();
		// …and the region world still mints its own identity afterwards. Order cannot matter:
		// membership rides in the importer's id, not in shared mutable state.
		const region = await rid(plugin).call(
			ctx as never,
			'./shared/Deep.svelte',
			`${ROOT}/src/lib/Header.svelte?og-region`,
			{ ssr: false }
		);
		expect((region as { id: string }).id).toBe(`${child}?og-region`);
	});
});
