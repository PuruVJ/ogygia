import vercel from '@sveltejs/adapter-vercel';
import node from '@sveltejs/adapter-node';

// PLAYGROUND_ADAPTER=node builds with adapter-node (it re-bundles the server output, the way the
// Amplify deployments do): what the profiler's embedded maps are checked against
const adapter = process.env.PLAYGROUND_ADAPTER === 'node' ? () => node() : (o) => vercel(o);
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Markdown content (`.svx`) so e2e/content-css can exercise the content-body CSS path. The island
	// preprocessor no-ops on `.svelte`, so every existing check is unaffected.
	extensions: ogygia.extensions(),
	preprocess: [vitePreprocess(), ...ogygia.preprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	kit: {
		adapter: adapter({ runtime: 'nodejs22.x' }),
		experimental: { remoteFunctions: true },
		// An app alias, the import shape the island-closure walk must follow (e2e/shared-page-module):
		// a module reached only through it is shared by a csr=true page and an island.
		alias: { $boot: 'src/lib/boot' },
		// Kit's own inline-vs-link number, which ogygia's region CSS obeys too: a region sheet under
		// it ships as `<style data-ogygia-region-css>` instead of a blocking `<link>`. Small on
		// purpose — only the tiny sheets of e2e/inline-css inline; every other suite keeps its links.
		inlineStyleThreshold: 400,
		// Kit bakes its version (default: the build's time) into its own client chunk, so without a
		// fixed one every build renames every island that imports Kit code. The cache check
		// (internal/bench/cache-bust-check.mjs) pins it, the way a deploy keyed to a commit would.
		...(process.env.PLAYGROUND_KIT_VERSION ? { version: { name: process.env.PLAYGROUND_KIT_VERSION } } : {})
	}
};

export default config;
