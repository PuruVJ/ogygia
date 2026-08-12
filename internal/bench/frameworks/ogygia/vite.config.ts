import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

// Islands in .md need ogygia's markdown preprocessor (runs after mdsvex) so `with { wake }`
// imports become real island bindings — plain mdsvex alone leaves them as normal components.
export default defineConfig({
	plugins: [
		ogygia({
			content: { markdown: {} },
			// The benchmark is a single blog page that never navigates — measure the islands runtime
			// only (apples-to-apples with Astro/Mochi, which ship no router). The SPA router is on by
			// default; `false` tree-shakes it out.
			router: false
		}),
		sveltekit({
			adapter: adapter({ strict: true }),
			extensions: ogygia.extensions(),
			preprocess: [vitePreprocess(), ...(await ogygia.preprocess())],
			prerender: { entries: ['*', '/posts/small', '/posts/medium', '/posts/large'] },
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	]
});
