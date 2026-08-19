// REGRESSION: ogygia's OWN injected runtime imports (`ogygia/internal` — Region / og_portable — and
// `ogygia/internal/server`) are written by the transform into a host component or a generated wrapper.
// A bare specifier resolves from the IMPORTER's package, so a host that lives in a monorepo sub-package
// which doesn't itself depend on ogygia can't resolve it:
//   Rolldown failed to resolve import "ogygia/internal" from ".../packages/builder-oem/.../Toolbar.svelte"
// ogygia is a CONSUMER-level dependency (the app's vite.config mounts the plugin), so the plugin must
// resolve its own injected imports from the app root, never per sub-package.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { Plugin } from 'vite';
import { ogygia } from '../dist/vite/index.js';

const ROOT = '/nonexistent-ogygia-consumer-app';
// Where the app-root resolution of ogygia lands (only the consumer has ogygia installed).
const CONSUMER_INTERNAL = `${ROOT}/node_modules/ogygia/dist/internal.js`;
const CONSUMER_SERVER = `${ROOT}/node_modules/ogygia/dist/internal-server.js`;
// A host that lives in a sub-package with NO ogygia in scope (outside the consumer root entirely).
const SUBPKG_HOST = '/somewhere/node_modules/builder-oem/src/components/Toolbar.svelte';

type Hook<T> = T | { handler: T };
const handler = <T>(hook: Hook<T>): T =>
	typeof hook === 'object' && hook !== null && 'handler' in (hook as object)
		? (hook as { handler: T }).handler
		: (hook as T);

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

/**
 * A `this.resolve` that mimics pnpm-strict: ONLY an importer under the consumer root can resolve
 * ogygia; a sub-package importer resolves to null. Returns the mapped id so the assertion proves the
 * plugin re-resolved from the CONSUMER, not from `importer`.
 */
const consumer_only = (map: Record<string, string>) => async (source: string, importer: string) => {
	if (source in map && importer && importer.startsWith(ROOT)) return { id: map[source] };
	return null; // the sub-package can't see ogygia
};

describe('ogygia injected imports resolve from the consumer, not the importer', () => {
	it('ogygia/internal from a sub-package host resolves via the app root', async () => {
		const plugin = make_plugin();
		const ctx = { resolve: consumer_only({ 'ogygia/internal': CONSUMER_INTERNAL }), emitFile: () => '' };
		const res = await handler(plugin.resolveId!).call(ctx as never, 'ogygia/internal', SUBPKG_HOST, {
			ssr: true
		});
		// Resolved despite the sub-package importer having no ogygia — i.e. it went through the root.
		expect(res).toEqual({ id: CONSUMER_INTERNAL });
	});

	it('ogygia/internal/server likewise', async () => {
		const plugin = make_plugin();
		const ctx = {
			resolve: consumer_only({ 'ogygia/internal/server': CONSUMER_SERVER }),
			emitFile: () => ''
		};
		const res = await handler(plugin.resolveId!).call(
			ctx as never,
			'ogygia/internal/server',
			SUBPKG_HOST,
			{ ssr: true }
		);
		expect(res).toEqual({ id: CONSUMER_SERVER });
	});

	it('the resolution is keyed off the consumer root, not the importer', async () => {
		const plugin = make_plugin();
		// Records which importer the plugin used to re-resolve.
		let usedImporter = '';
		const ctx = {
			resolve: async (source: string, importer: string) => {
				usedImporter = importer;
				return source === 'ogygia/internal' && importer.startsWith(ROOT)
					? { id: CONSUMER_INTERNAL }
					: null;
			},
			emitFile: () => ''
		};
		await handler(plugin.resolveId!).call(ctx as never, 'ogygia/internal', SUBPKG_HOST, { ssr: true });
		expect(usedImporter.startsWith(ROOT), `re-resolved from '${usedImporter}', expected under ${ROOT}`).toBe(true);
		expect(usedImporter).not.toBe(SUBPKG_HOST);
		expect(path.dirname(usedImporter)).toBe(ROOT);
	});
});
