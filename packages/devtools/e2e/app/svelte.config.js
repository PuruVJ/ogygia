import vercel from '@sveltejs/adapter-vercel';
import node from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// LAB_ADAPTER=node builds with adapter-node (it re-bundles the server output, the way a Lambda-style
// deployment does): what the profiler's embedded maps are checked against
const adapter = process.env.LAB_ADAPTER === 'node' ? () => node() : (o) => vercel(o);

const PLANTED = /\/(lib|routes)\/(heavy|hell|hell-fixed|inferno|inferno-fixed)\//;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [vitePreprocess()],
	compilerOptions: {
		experimental: { async: true },
		// The profiler's planted-problem pages (heavy, hell, inferno, and their `-fixed` twins) are
		// test fixtures whose code shape IS the test: each renders once, on the server, and reads its
		// props once in plain script, the way the app code they imitate does. Rewriting them to
		// `$derived` or `$state` would move the work the profiler's answer key measures, so the
		// one-time-read and plain-local warnings are off for those folders only.
		warningFilter: (w) =>
			!(
				(w.code === 'state_referenced_locally' || w.code === 'non_reactive_update') &&
				PLANTED.test(w.filename ?? '')
			)
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
