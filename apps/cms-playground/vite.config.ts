import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

/** SvelteKit's config (Kit 3: passed to `sveltekit()`; a `svelte.config.js` is an error). A function:
 *  `ogygia.extensions()` / `.preprocess()` read the `ogygia()` call, so it runs after it. */
const kit = () => ({
	adapter: adapter(),
	extensions: ogygia.extensions(),
	preprocess: [vitePreprocess(), ...ogygia.preprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	experimental: { remoteFunctions: true }
});

// The CMS playground has NO local markdown — every entry comes over HTTP from the fake CMS API
// (see src/routes/api). The ogygia plugin is still needed for islands (`with { region, wake }`).
export default defineConfig({
	resolve: { dedupe: ['@sveltejs/kit'] },
	plugins: [ogygia(), sveltekit(kit())]
});
