// REGRESSION: ogygia's OWN injected runtime imports (`ogygia/internal` — Region / og_portable — and
// `ogygia/internal/server`) are written by the transform into a host component or a generated wrapper.
// A bare specifier resolves from the IMPORTER's package, so a host that lives in a monorepo sub-package
// which doesn't itself depend on ogygia can't resolve it:
//   Rolldown failed to resolve import "ogygia/internal" from ".../packages/builder-oem/.../Toolbar.svelte"
// The fix re-bases the resolution off ogygia's OWN package (PKG_ROOT — where the plugin file lives),
// which always exists and is the exact ogygia the app loaded `ogygia/vite` from (one instance, no
// Region/brand identity fork). The consumer `root` is only a fallback and is SKIPPED when unset — a
// throwaway plugin instance whose `configResolved` never ran leaves `root` undefined, which is what
// broke the earlier `path.join(root, …)` attempt.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { ogygia } from '../dist/vite/index.js';

// The ogygia package root — the SAME dir the plugin derives as PKG_ROOT (from `dist/vite/index.js` →
// `../..`). This test file is `packages/ogygia/test/…`, so `..` is the package root.
const PKG_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SELF_INTERNAL = `${PKG_ROOT}/dist/internal.js`;
const SELF_SERVER = `${PKG_ROOT}/dist/internal-server.js`;

const ROOT = '/nonexistent-ogygia-consumer-app';
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
	// `root` is undefined — the exact condition under which the old consumer-root resolution broke.
	if (configure) {
		handler(plugin.configResolved!).call(null as never, {
			root: ROOT,
			base: '/',
			command: 'serve',
			mode: 'development',
			envDir: false,
			build: {}
		} as never);
	}
	return plugin;
}

/**
 * A `this.resolve` that mimics pnpm-strict: ogygia is resolvable ONLY from ogygia's own package
 * (self-reference) — NOT from the sub-package host, and NOT from the consumer root. Records every
 * importer it was asked about so a test can assert the plugin re-based off PKG_ROOT.
 */
const self_only = (map: Record<string, string>, seen: string[]) => {
	return async (source: string, importer: string) => {
		seen.push(importer);
		if (source in map && importer && importer.startsWith(PKG_ROOT)) return { id: map[source] };
		return null; // neither the sub-package nor the bare consumer root can see ogygia here
	};
};

describe('ogygia injected imports resolve from ogygia\'s own package, not the importer', () => {
	it('ogygia/internal from a sub-package host resolves via self-reference (PKG_ROOT)', async () => {
		const plugin = make_plugin();
		const seen: string[] = [];
		const ctx = { resolve: self_only({ 'ogygia/internal': SELF_INTERNAL }, seen), emitFile: () => '' };
		const res = await handler(plugin.resolveId!).call(ctx as never, 'ogygia/internal', SUBPKG_HOST, {
			ssr: true
		});
		expect(res).toEqual({ id: SELF_INTERNAL });
		// It re-based off ogygia's own package and NEVER off the sub-package importer.
		expect(seen.some((i) => i.startsWith(PKG_ROOT))).toBe(true);
		expect(seen).not.toContain(SUBPKG_HOST);
	});

	it('ogygia/internal/server likewise', async () => {
		const plugin = make_plugin();
		const seen: string[] = [];
		const ctx = {
			resolve: self_only({ 'ogygia/internal/server': SELF_SERVER }, seen),
			emitFile: () => ''
		};
		const res = await handler(plugin.resolveId!).call(
			ctx as never,
			'ogygia/internal/server',
			SUBPKG_HOST,
			{ ssr: true }
		);
		expect(res).toEqual({ id: SELF_SERVER });
	});

	it('resolves even when `root` is unset (throwaway instance whose configResolved never ran)', async () => {
		const plugin = make_plugin(false); // no configResolved → root is undefined
		const seen: string[] = [];
		const ctx = { resolve: self_only({ 'ogygia/internal': SELF_INTERNAL }, seen), emitFile: () => '' };
		const res = await handler(plugin.resolveId!).call(ctx as never, 'ogygia/internal', SUBPKG_HOST, {
			ssr: true
		});
		// The old code did `path.join(root, …)` with root=undefined and resolved from a bogus base;
		// self-reference off PKG_ROOT is independent of `root`, so it still resolves.
		expect(res).toEqual({ id: SELF_INTERNAL });
		expect(seen).not.toContain(SUBPKG_HOST);
	});

	it('the consumer root is a FALLBACK when self-reference misses', async () => {
		const plugin = make_plugin();
		const CONSUMER_INTERNAL = `${ROOT}/node_modules/ogygia/dist/internal.js`;
		const seen: string[] = [];
		// Self-ref (PKG_ROOT) misses here; only the consumer root resolves.
		const ctx = {
			resolve: async (source: string, importer: string) => {
				seen.push(importer);
				return source === 'ogygia/internal' && importer.startsWith(ROOT)
					? { id: CONSUMER_INTERNAL }
					: null;
			},
			emitFile: () => ''
		};
		const res = await handler(plugin.resolveId!).call(ctx as never, 'ogygia/internal', SUBPKG_HOST, {
			ssr: true
		});
		expect(res).toEqual({ id: CONSUMER_INTERNAL });
		// PKG_ROOT was tried FIRST, then the consumer root — never the sub-package importer.
		expect(seen[0].startsWith(PKG_ROOT)).toBe(true);
		expect(seen.some((i) => i.startsWith(ROOT))).toBe(true);
		expect(seen).not.toContain(SUBPKG_HOST);
	});
});
