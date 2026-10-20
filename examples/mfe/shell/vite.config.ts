import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// `freeze: true` = the shell's pages are frozen pages. Its anonymous home bakes a static dash
	// widget and freezes; a publish or deploy on the dash team thaws it via a cross-app thaw notice
	// (federation v2). The /cms/* mount pages read the shell's decided flags, so they stay per-request.
	plugins: [
		ogygia({ freeze: true }),
		// SvelteKit's config (Kit 3: passed to `sveltekit()`; a `svelte.config.js` is an error)
		sveltekit({
			adapter: adapter(),
			preprocess: [vitePreprocess()],
			compilerOptions: { experimental: { async: true } }
		})
	]
});
