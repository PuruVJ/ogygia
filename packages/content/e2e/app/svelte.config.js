import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocess, extensions } from '@ogygia/content/vite';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Markdown content (`.svx`) so the content-css spec can exercise the content-body CSS path.
	extensions: extensions(),
	preprocess: [vitePreprocess(), ...preprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	kit: {
		adapter: adapter(),
		experimental: { remoteFunctions: true },
		// Kit's own inline-vs-link number, which ogygia's region CSS obeys too: a region sheet under it
		// ships as `<style data-ogygia-region-css>` instead of a blocking `<link>`
		inlineStyleThreshold: 400
	}
};

export default config;
