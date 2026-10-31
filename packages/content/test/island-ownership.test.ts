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
 *
 * The compiler half (the server-island host legs the registry depends on) lives in core's
 * island-ownership.test.ts.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __set_build_cache_root } from '@ogygia/core/internal/compiler-browser';
import { ogygiaPreprocess } from '../src/markdown/index.ts';
import { bridge } from '../src/bridge.ts';

// The markup hook now consults the doc-level markup cache — isolate it, or a previous run's
// entry short-circuits before the bridge is consulted.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-ownership-'));
__set_build_cache_root(tmp);
afterAll(() => {
	__set_build_cache_root(undefined);
	fs.rmSync(tmp, { recursive: true, force: true });
});

// What the PLUGIN transform leaves behind on the csr=false client leg for a route host with a marked
// server island (mark consumed → stub import) and a fallback snippet child. This is the shape the
// markup hook actually receives for a `.svelte` — the phantom's trigger.
const PLUGIN_OUTPUT = `<script lang="ts">
	import DeferredHole from 'virtual:ogygia/client-binding-stub';
</script>

<DeferredHole>
	{#snippet ogygiaFallback()}<p>loading…</p>{/snippet}
</DeferredHole>
`;

const prev_transform = bridge.transform;
afterEach(() => {
	bridge.transform = prev_transform;
});

describe('island-transform ownership', () => {
	it('the markup hook does NOT island-transform a .svelte (no bridge call, no phantom)', async () => {
		const calls: string[] = [];
		bridge.transform = (_content, filename) => {
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
		bridge.transform = (_content, filename) => {
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
