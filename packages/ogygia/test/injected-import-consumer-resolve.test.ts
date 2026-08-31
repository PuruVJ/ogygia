// REGRESSION: ogygia's OWN injected runtime imports (`ogygia/internal` — Region / og_portable — and
// `ogygia/internal/server`) are written by the transform into a host component or a generated island
// module. A bare specifier resolves from the IMPORTER's package, so a host in a monorepo sub-package
// which doesn't itself depend on ogygia can't resolve it:
//   Rolldown failed to resolve import "ogygia/internal" from ".../packages/builder-oem/.../Toolbar.svelte"
// The plugin resolves these to ogygia's OWN files DIRECTLY — never through `this.resolve` (unreliable
// off a synthetic importer: returns null in vite@8, can THROW in rolldown-vite@7, which aborts the
// hook) and never through `config.root` (undefined on a throwaway Kit plugin instance). This test
// pins that: resolution succeeds from ANY importer, with a `this.resolve` that throws if touched, and
// with `configResolved` never run.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { ogygia } from '../dist/vite/index.js';

// The ogygia package root — the SAME dir the plugin derives as PKG_ROOT. This test file is
// `packages/ogygia/test/…`, so `..` is the package root.
const PKG_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
// Match the plugin's own src-vs-dist choice: source checkout → src, published install → dist.
const HAS_SRC = fs.existsSync(path.join(PKG_ROOT, 'src/internal.ts'));
const INTERNAL = path.join(PKG_ROOT, HAS_SRC ? 'src/internal.ts' : 'dist/internal.js');
const SERVER = path.join(PKG_ROOT, HAS_SRC ? 'src/internal-server.ts' : 'dist/internal-server.js');

// A host that lives in a sub-package with NO ogygia in scope (outside the consumer root entirely).
const SUBPKG_HOST = '/somewhere/node_modules/builder-oem/src/components/Toolbar.svelte';

type Hook<T> = T | { handler: T };
const handler = <T>(hook: Hook<T>): T =>
	typeof hook === 'object' && hook !== null && 'handler' in (hook as object)
		? (hook as { handler: T }).handler
		: (hook as T);

function make_plugin(configure = true): Plugin {
	const plugin = ogygia().find((p) => p.name === 'ogygia')!;
	delete process.env.OGYGIA_SECRET;
	// `configure = false` simulates a throwaway plugin instance whose `configResolved` never ran, so
	// `root` is undefined — a condition the resolution must not depend on.
	if (configure) {
		handler(plugin.configResolved!).call(
			null as never,
			{
				root: '/nonexistent-ogygia-consumer-app',
				base: '/',
				command: 'serve',
				mode: 'development',
				envDir: false,
				build: {}
			} as never
		);
	}
	return plugin;
}

// A `this.resolve` that THROWS if called — the resolution must NOT touch it (that is the exact hook
// that aborts in rolldown-vite@7 off a synthetic importer).
const ctx_that_forbids_resolve = () => ({
	resolve: () => {
		throw new Error('this.resolve must not be called for ogygia injected imports');
	},
	emitFile: () => ''
});

describe("ogygia injected imports resolve to ogygia's own files, without this.resolve", () => {
	it('ogygia/internal from a sub-package host resolves directly', async () => {
		const plugin = make_plugin();
		const res = await handler(plugin.resolveId!).call(
			ctx_that_forbids_resolve() as never,
			'ogygia/internal',
			SUBPKG_HOST,
			{ ssr: true }
		);
		expect(res).toBe(INTERNAL);
	});

	it('ogygia/internal/server likewise', async () => {
		const plugin = make_plugin();
		const res = await handler(plugin.resolveId!).call(
			ctx_that_forbids_resolve() as never,
			'ogygia/internal/server',
			SUBPKG_HOST,
			{ ssr: true }
		);
		expect(res).toBe(SERVER);
	});

	it('resolves even when `root` is unset (throwaway instance whose configResolved never ran)', async () => {
		const plugin = make_plugin(false); // no configResolved → root is undefined
		const res = await handler(plugin.resolveId!).call(
			ctx_that_forbids_resolve() as never,
			'ogygia/internal',
			SUBPKG_HOST,
			{ ssr: true }
		);
		expect(res).toBe(INTERNAL);
	});

	it('does not depend on the importer (same result from the app root)', async () => {
		const plugin = make_plugin();
		const res = await handler(plugin.resolveId!).call(
			ctx_that_forbids_resolve() as never,
			'ogygia/internal',
			'/nonexistent-ogygia-consumer-app/src/routes/+layout.svelte',
			{ ssr: false }
		);
		expect(res).toBe(INTERNAL);
	});

	it('the resolved file actually exists on disk', () => {
		expect(fs.existsSync(INTERNAL)).toBe(true);
		expect(fs.existsSync(SERVER)).toBe(true);
	});
});
