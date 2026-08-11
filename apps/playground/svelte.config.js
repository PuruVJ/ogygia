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
		experimental: { remoteFunctions: true }
	}
};

export default config;
