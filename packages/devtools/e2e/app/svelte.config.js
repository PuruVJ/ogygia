import vercel from '@sveltejs/adapter-vercel';
import node from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// LAB_ADAPTER=node builds with adapter-node (it re-bundles the server output, the way a Lambda-style
// deployment does): what the profiler's embedded maps are checked against
const adapter = process.env.LAB_ADAPTER === 'node' ? () => node() : (o) => vercel(o);

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [vitePreprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	kit: {
		adapter: adapter({ runtime: 'nodejs22.x' }),
		experimental: { remoteFunctions: true },
		alias: { $boot: 'src/lib/boot' },
		// the same inline-vs-link number as the palaestra: the region-css channel ships tiny sheets inline
		inlineStyleThreshold: 400,
		// Kit bakes its version (default: the build's time) into its own client chunk, so without a
		// fixed one every build renames every island that imports Kit code. The cache check
		// (internal/bench/cache-bust-check.ts) pins it, the way a deploy keyed to a commit would.
		...(process.env.LAB_KIT_VERSION ? { version: { name: process.env.LAB_KIT_VERSION } } : {})
	}
};

export default config;
