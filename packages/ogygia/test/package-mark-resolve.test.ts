// A marked PACKAGE-specifier island re-emits its original specifier inside the generated virtual
// modules; when Vite cannot resolve that specifier the plugin's resolveId must fail LOUDLY (repo
// convention: actionable errors), not fall through to an opaque "Failed to resolve import".

import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { ogygia } from '../dist/vite/index.js';
import { regionId, regionIdentity, wrapperVirtualId } from '../dist/compiler/region/transform.js';

const ROOT = '/nonexistent-ogygia-test-app';
// A shared LIB component, not a route host: `routeCsrIsTrue` treats a `+page.svelte` with no
// on-disk `csr = false` as Kit-default csr=true and ogygia steps aside (no island) — and this
// test's ROOT has no files at all. Lib components always keep their islands.
const HOST = `${ROOT}/src/lib/Widget.svelte`;
const SPEC = 'not-installed-pkg/tabs';

type Hook<T> = T | { handler: T };
const handler = <T>(hook: Hook<T>): T =>
	(typeof hook === 'object' && hook !== null && 'handler' in (hook as object)
		? (hook as { handler: T }).handler
		: (hook as T));

function make_plugin(): Plugin {
	const plugin = ogygia().find((p) => p.name === 'ogygia')!;
	delete process.env.OGYGIA_SECRET; // keep region ids salt-free for the id computed below
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

describe('unresolvable marked package specifier', () => {
	it('resolveId throws an actionable [ogygia] error for the re-emitted specifier', async () => {
		const plugin = make_plugin();
		const ctx = { resolve: async () => null, emitFile: () => '' };
		const src = `<script>\nimport TabGroup from '${SPEC}' with { wake: 'load' };\n</script>\n<TabGroup />`;
		// Register the host (SSR leg) so the wrapper virtual is in the registry. `transform` is async
		// (the macro leg awaits), so await it before reading the registry it populates.
		await handler(plugin.transform!).call(ctx as never, src, HOST, { ssr: true });
		const iid = regionId(regionIdentity(SPEC, { strategy: 'load', options: {} }));
		await expect(
			handler(plugin.resolveId!).call(ctx as never, SPEC, wrapperVirtualId(iid), { ssr: true })
		).rejects.toThrow(/\[ogygia\] cannot resolve 'not-installed-pkg\/tabs'[\s\S]*exports/);
	});

	it('relative imports from a generated module keep the quiet null fall-through', async () => {
		const plugin = make_plugin();
		const ctx = { resolve: async () => null, emitFile: () => '' };
		const src = `<script>\nimport TabGroup from '${SPEC}' with { wake: 'load' };\n</script>\n<TabGroup />`;
		await handler(plugin.transform!).call(ctx as never, src, HOST, { ssr: true });
		const iid = regionId(regionIdentity(SPEC, { strategy: 'load', options: {} }));
		await expect(
			handler(plugin.resolveId!).call(ctx as never, './local.js', wrapperVirtualId(iid), { ssr: true })
		).resolves.toBeNull();
	});
});
