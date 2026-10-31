import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocess, extensions } from '@ogygia/content/vite';

// Kit config lives in svelte.config.js (the Kit v2 home) so `svelte-check` AND the editor's Svelte
// language server — both of which read svelte.config.js, never vite.config — see the extensions and
// preprocessors. Under svelte-check the content plugin hasn't run, so `preprocess()` returns nothing
// and `extensions()` just `.svelte`; during the real Vite build the plugin (in vite.config) has
// already registered its markdown config, so the SAME calls also return the mdsvex pass and the
// `.svx` / `.md` extensions. One source, both pipelines.
/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: extensions(),
	preprocess: [vitePreprocess(), ...preprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	kit: {
		adapter: adapter({ runtime: 'nodejs22.x' }),
		experimental: { remoteFunctions: true }
	}
};

export default config;
