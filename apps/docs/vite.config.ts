import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { diff_markers, inline_markers } from 'ogygia/content/markdown';
import { defineConfig } from 'vite';
import { load_ogygia_themes } from './src/lib/code/shiki-themes.js';
import { remarkChangelog } from './src/lib/remark-changelog.js';

// Custom site Shiki themes (forest neutrals + green) — the same ogygia-light / ogygia-dark used by
// the snippets highlighter, so .svx fences match hand-highlighted code.
const themes = await load_ogygia_themes();

// Plugins live here; Kit config (adapter, extensions, preprocess) lives in svelte.config.js — the
// Kit v2 home that `svelte-check` and the editor's Svelte language server read. The ogygia() plugin
// registers its markdown config synchronously here (before sveltekit() loads svelte.config.js), so
// the value-free `ogygia.extensions()` / `ogygia.preprocess()` in svelte.config.js resolve to the
// full markdown + island pipeline for the build.
export default defineConfig({
	plugins: [
		ogygia({
			visible: { margin: '120px' },
			presets: {
				demo: { wake: 'visible', margin: '200px' },
				frozenSwr: { render: 'live', wake: 'load' },
			},
			content: {
				markdown: {
					themes: { light: themes.light, dark: themes.dark },
					defaultColor: 'light-dark()',
					wrapperClass: 'code-only',
					// The two diff dialects (line `+++ `/`--- ` prefixes + inline `+++x+++`/`---x---`),
					// dogfooded on the markdown-authoring page.
					code: { transformers: [diff_markers(), inline_markers()] },
					// Reshape the Releases page's `## [x] — date` headings into a clean version + a date
					// line under it. `enforce: 'pre'` so the heading-id/TOC collectors see "0.5.0".
					remark: [{ enforce: 'pre', plugin: remarkChangelog }],
				},
			},
		}),
		sveltekit(),
	],
});
