import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';

// Kit config lives in svelte.config.js (the Kit v2 home) so `svelte-check` AND the editor's Svelte
// language server — both of which read svelte.config.js, never vite.config — see the island
// preprocessor and extensions. That's what teaches them the `ogygiaFallback` call-site shape with no
// per-component prop declaration. Under svelte-check the ogygia plugin hasn't run, so
// `ogygia.preprocess()` returns just the island types-pass (and `.svelte` only); during the real
// Vite build the plugin (in vite.config) has already registered its markdown config, so the SAME
// calls also return the mdsvex pass and the `.svx` / `.md` extensions. One source, both pipelines.
/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: ogygia.extensions(),
	preprocess: [vitePreprocess(), ...ogygia.preprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	kit: {
		adapter: adapter({ runtime: 'nodejs22.x' }),
		experimental: { remoteFunctions: true }
	}
};

export default config;
