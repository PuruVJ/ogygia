import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: ogygia.extensions(),
	preprocess: [vitePreprocess(), ...ogygia.preprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	kit: {
		adapter: adapter(),
		experimental: { remoteFunctions: true }
	}
};

export default config;
