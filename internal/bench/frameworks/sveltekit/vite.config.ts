import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { mdsvex } from 'mdsvex';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({ strict: true }),
			extensions: ['.svelte', '.svx', '.md'],
			preprocess: [mdsvex({ extensions: ['.svx', '.md'] }), vitePreprocess()],
			prerender: { entries: ['*', '/posts/small', '/posts/medium', '/posts/large'] },
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	]
});
