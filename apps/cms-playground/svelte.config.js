import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocess, extensions } from '@ogygia/content/vite';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: extensions(),
	preprocess: [vitePreprocess(), ...preprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	kit: {
		adapter: adapter(),
		experimental: { remoteFunctions: true }
	}
};

export default config;
