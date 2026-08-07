import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		experimental: { async: true }
	},
	kit: {
		adapter: adapter({ runtime: 'nodejs22.x' }),
		// Inline page CSS (<20 KiB each) to cut render-blocking stylesheet round-trips on `/`.
		inlineStyleThreshold: 20_000,
		experimental: { remoteFunctions: true }
	}
};

export default config;
