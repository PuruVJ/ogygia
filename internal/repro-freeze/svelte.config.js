import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: [vitePreprocess()],
	// Async Svelte (the live-header demo awaits a remote query in its script) + remote functions.
	compilerOptions: {
		experimental: { async: true }
	},
	kit: { adapter: adapter(), experimental: { remoteFunctions: true } }
};

export default config;
