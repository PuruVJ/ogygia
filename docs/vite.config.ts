import adapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';
import { load_ogygia_themes } from './src/lib/code/shiki-themes.js';

// Custom site Shiki themes (forest neutrals + green) — the same ogygia-light / ogygia-dark used by
// the snippets highlighter, so .svx fences match hand-highlighted code.
const themes = await load_ogygia_themes();

// SvelteKit config lives here (v2.62+): passed straight to sveltekit(). No svelte.config.js.
export default defineConfig({
	plugins: [
		// One config surface: islands + content/markdown all here. The svelte config only needs the
		// value-free `ogygia.preprocess()` + `ogygia.extensions()`.
		ogygia({
			visible: { margin: '120px' },
			presets: {
				demo: { hydrate: 'visible', margin: '200px' },
				frozenSwr: { hydrate: 'none', remount: { revalidate: 'load' } },
			},
			content: {
				markdown: {
					themes: { light: themes.light, dark: themes.dark },
					defaultColor: 'light-dark()',
					wrapperClass: 'code-only',
				},
			},
		}),
		sveltekit({
			adapter: adapter({ runtime: 'nodejs22.x' }),
			experimental: { remoteFunctions: true },
			// `.svx` docs pages compile alongside `.svelte` — marked island imports work in both.
			extensions: ogygia.extensions(),
			preprocess: [vitePreprocess(), ...(await ogygia.preprocess())],
			compilerOptions: {
				experimental: { async: true },
			},
		}),
	],
});
