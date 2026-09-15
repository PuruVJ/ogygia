/**
 * A wake island's wrapper is leg-split: SSR imports the entry (it renders), the CLIENT leg imports a
 * lazy module that imports the entry only when the document rendered the island. This is what keeps
 * a csr=true host's page graph at the wrapper — Kit links stylesheets and preloads from the static
 * client graph, and a 337-mark block registry imported by one csr=true route used to link every
 * block's sheet on every page. The record `make_wake_island` mints carries both legs + the lazy
 * module; the driver serves the client leg for `ssr: false`.
 */
import { describe, expect, it } from 'vitest';
import { make_wake_island, lazy_entry_source, island_wrapper_client_source } from '../src/compiler/region/emit.js';
import { lazyEntryVirtualId } from '../src/compiler/ids.js';
import { is_island_path } from '../src/compiler/region/transform.js';

const record = () =>
	make_wake_island({
		iid: 'abc123',
		componentPath: '/app/src/lib/Block.svelte',
		entryPath: 'virtual:ogygia/island/abc123.js',
		wrapperPath: 'virtual:ogygia/wrapper/abc123.svelte',
		moduleUrl: '/_app/immutable/og-region.abc123.js',
		strategy: 'visible',
		options: { margin: '200px' },
		hostPath: '/app/src/routes/+page.svelte',
		identity: 'x',
		lang: ' lang="ts"'
	});

describe('wake island — the wrapper is leg-split, the client leg is lazy', () => {
	it('mints a client wrapper that imports the LAZY module, never the component or the entry', () => {
		const r = record() as Record<string, string>;
		expect(r.lazyPath).toBe(lazyEntryVirtualId('abc123'));
		expect(r.wrapperClientSource).toContain(`import __OgygiaEntry, { load as __OgygiaLoad } from "virtual:ogygia/lazy/abc123.js";`);
		expect(r.wrapperClientSource).not.toContain('Block.svelte');
		expect(r.wrapperClientSource).not.toContain('virtual:ogygia/island/abc123.js');
		expect(r.wrapperClientSource).toContain('__component={__OgygiaEntry} __load={__OgygiaLoad}');
		expect(r.wrapperClientSource).toContain('__entry={"/_app/immutable/og-region.abc123.js"}');
		expect(r.wrapperClientSource).toContain('<script lang="ts">');
		// the SSR wrapper is unchanged: it renders, so it imports the entry and the component
		expect(r.wrapperSource).toContain('import __OgygiaEntry from "virtual:ogygia/island/abc123.js";');
		expect(r.wrapperSource).toContain('Block.svelte');
	});

	it('the lazy module reads the ONE csr fact + the rendered stamp, top-level-awaits the entry, and exports an on-demand load', () => {
		const src = lazy_entry_source('virtual:ogygia/island/abc123.js', '/_app/immutable/og-region.abc123.js');
		expect(src).toContain(`import { documentIsCsrTrue } from 'ogygia/internal';`);
		expect(src).toContain(`document.querySelector("meta[name=\\"ogygia-kit-island\\"][content=\\"/_app/immutable/og-region.abc123.js\\"]")`);
		expect(src).toContain(`export default documentIsCsrTrue() && !rendered ? undefined : (await import("virtual:ogygia/island/abc123.js")).default;`);
		expect(src).toContain(`export const load = () => import("virtual:ogygia/island/abc123.js").then((m) => m.default);`);
		expect(src).not.toMatch(/__sveltekit_/); // no private Kit-page probe of its own
	});

	it('the lazy id is an ogygia-owned island path (resolved + shimmed like the other glue)', () => {
		expect(is_island_path(lazyEntryVirtualId('abc123'))).toBe(true);
		expect(is_island_path('virtual:ogygia/lazy/abc123.js?x')).toBe(true);
	});

	it('a stamp with a quote in the entry cannot break out of the selector', () => {
		const src = lazy_entry_source('virtual:ogygia/island/q.js', '/x"y.js');
		expect(src).toContain(JSON.stringify(`meta[name="ogygia-kit-island"][content=${JSON.stringify('/x"y.js')}]`));
	});

	it('keep + strategy attributes ride the client wrapper exactly as the SSR one', () => {
		const client = island_wrapper_client_source('i', 'virtual:ogygia/lazy/i.js', 'load', { keep: 'nav' }, '/e.js', '');
		expect(client).toContain('__keep={"nav"}');
		expect(client).toContain('__mode="island" load');
	});
});
