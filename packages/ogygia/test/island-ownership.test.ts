/**
 * REGRESSION — island-transform ownership (the csr=false + `render:'deferred'` prerender crash).
 *
 * The rule: the markup preprocessor island-transforms CONTENT files (`.svx`/`.md`) ONLY. Islands in
 * a `.svelte` belong to the Vite plugin's transform hook, which runs BEFORE vite-plugin-svelte —
 * so by the time the markup hook sees a `.svelte`, marked imports are ALREADY rewritten. Running
 * the bridge there transformed the plugin's OUTPUT: a server island read as a plain component, its
 * `{#snippet}` children were branded as phantom portable snippets, and registering that phantom
 * WIPED the host's real wrapper registration — the cold build then failed to resolve
 * `virtual:ogygia/wrapper/<hash>.svelte` (client) or leaked it raw into the server bundle
 * (`ERR_UNSUPPORTED_ESM_URL_SCHEME: virtual:` at prerender).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ogygiaPreprocess } from '../src/content/markdown/index.js';
import { islandBridge } from '../src/vite/island-bridge.js';
import { transformHost } from '../src/compiler/region/transform.js';
import { __set_build_cache_root } from '../src/build-cache.js';

// The markup hook now consults the doc-level markup cache — isolate it, or a previous run's
// entry short-circuits before the bridge is consulted.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-ownership-'));
__set_build_cache_root(tmp);
afterAll(() => {
	__set_build_cache_root(undefined);
	fs.rmSync(tmp, { recursive: true, force: true });
});

// A csr=false route host: a marked server island with a fallback snippet child.
const ROUTE_HOST = `<script lang="ts">
	import DeferredHole from './DeferredHole.svelte' with { render: 'deferred' };
</script>

<DeferredHole>
	{#snippet ogygiaFallback()}<p>loading…</p>{/snippet}
</DeferredHole>
`;

// What the PLUGIN transform leaves behind on the csr=false client leg (mark consumed → stub import).
// This is the shape the markup hook actually receives for a `.svelte` — the phantom's trigger.
const PLUGIN_OUTPUT = ROUTE_HOST.replace(
	`import DeferredHole from './DeferredHole.svelte' with { render: 'deferred' };`,
	`import DeferredHole from 'virtual:ogygia/client-binding-stub';`
);

const prev_transform = islandBridge.transform;
afterEach(() => {
	islandBridge.transform = prev_transform;
});

describe('island-transform ownership', () => {
	it('the markup hook does NOT island-transform a .svelte (no bridge call, no phantom)', async () => {
		const calls: string[] = [];
		islandBridge.transform = (content, filename) => {
			calls.push(filename);
			return null;
		};
		const pp = ogygiaPreprocess({});
		const out = await pp.markup!({
			content: PLUGIN_OUTPUT,
			filename: '/app/src/routes/demo/deferred/+page.svelte'
		});
		// Non-content: untouched (undefined = "no change"), and the bridge was never consulted —
		// a bridge call here is exactly the phantom-registration path that wiped the wrapper.
		expect(out).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it('the markup hook still island-transforms CONTENT files through the bridge', async () => {
		const calls: string[] = [];
		islandBridge.transform = (content, filename) => {
			calls.push(filename);
			return null; // no islands — markup continues with mdsvex output
		};
		const pp = ogygiaPreprocess({});
		const out = await pp.markup!({
			content: '# hello\n\nsome prose\n',
			filename: '/app/src/content/docs/x/+doc.svx'
		});
		expect(out).toBeDefined(); // content compiled
		expect(calls.length).toBe(1); // bridge consulted exactly once, for the content file
		expect(calls[0]).toContain('+doc.svx');
	});
});

describe('server-island host legs (the compiler contract the registry depends on)', () => {
	const ctx = {
		root: '/app',
		libDir: '/app/src/lib',
		readFile: () => null,
		pathModule: path,
		dev: false,
		virtualPathFor: (_h: string, iid: string) => `virtual:ogygia/island/${iid}.js`,
		wrapperPathFor: (_h: string, iid: string) => `virtual:ogygia/wrapper/${iid}.svelte`,
		devUrlFor: (p: string) => p,
		visibleMargin: '200px',
		presets: {},
		importKeys: {},
		idSalt: '',
		clientBindingStub: 'virtual:ogygia/client-binding-stub',
		routeCsr: undefined
	};
	const id = '/app/src/routes/demo/deferred/+page.svelte';

	it('SSR leg: wrapper import + island registered WITH wrapper source', () => {
		const r = transformHost(ROUTE_HOST, id, { ...ctx, ssr: true, linkVirtualIsland: true });
		expect(r!.code).toContain('virtual:ogygia/wrapper/');
		const isl = r!.islands![0]!;
		expect(isl.server).toBe(true);
		expect((isl.wrapperSource ?? '').length).toBeGreaterThan(0);
	});

	it('csr=false CLIENT leg: stub import (never the wrapper), island still carries wrapper source', () => {
		const r = transformHost(ROUTE_HOST, id, { ...ctx, ssr: false, linkVirtualIsland: false });
		expect(r!.code).not.toContain('virtual:ogygia/wrapper/');
		expect(r!.code).toContain('virtual:ogygia/client-binding-stub');
		const isl = r!.islands![0]!;
		expect(isl.server).toBe(true);
		// the registration payload must never be a downgrade — the registry gate needs the source
		expect((isl.wrapperSource ?? '').length).toBeGreaterThan(0);
	});

	it('already-transformed output does not conjure a phantom island from the fallback snippet', () => {
		// The exact input that produced the phantom: mark consumed, stub import, snippet child.
		const r = transformHost(PLUGIN_OUTPUT, id, { ...ctx, ssr: false, linkVirtualIsland: true });
		const portable = (r?.islands ?? []).filter((i) => (i as { portable?: boolean }).portable);
		expect(portable).toEqual([]);
	});
});
