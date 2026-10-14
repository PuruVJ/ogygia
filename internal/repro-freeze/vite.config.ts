import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// The freeze fixture: `freeze: true` = the whole adoption (tier-1 memory store;
	// e2e/freeze.ts wires edge adapters at the emulators through hooks.server.ts).
	plugins: [
		ogygia({ freeze: true }),
		sveltekit({
			adapter: adapter(),
			preprocess: [vitePreprocess()],
			// Async Svelte (the live-header demo awaits a remote query in its script) + remote functions.
			compilerOptions: {
				experimental: { async: true }
			},
			experimental: { remoteFunctions: true },
			// adapter-node reads the origin at BUILD time (no runtime ORIGIN): the spec serves over
			// plain http, so the build is told — or its form POSTs fail Kit's same-origin check
			...(process.env.ORIGIN ? { paths: { origin: process.env.ORIGIN } } : {})
		})
	]
});
