import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { diff_markers, inline_markers } from 'ogygia/content/markdown';
import { defineConfig } from 'vite';
import { load_ogygia_themes } from './src/lib/code/shiki-themes.js';
import { remarkChangelog } from './src/lib/remark-changelog.js';
import { expandApi, expandApiCacheKey, expandApiDependencies } from './src/lib/api-ref/expand-api.ts';

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
			regions: {
				visible: { margin: '120px' },
				presets: {
					demo: { wake: 'visible', margin: '200px' },
					frozenSwr: { render: 'live', wake: 'load' },
				},
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
					// expandApi: `> MODULE: ogygia/…` → the auto-generated API reference, regenerated from
					// the package's own d.ts on every build — cache_key re-keys the doc cache when the
					// d.ts set changes; dependencies lets Vite recompile affected pages in dev.
					remark: [
						{ enforce: 'pre', plugin: remarkChangelog },
						{
							enforce: 'pre',
							plugin: expandApi,
							cache_key: expandApiCacheKey,
							dependencies: expandApiDependencies,
						},
					],
				},
				// The /playground sub-app's markdown variant: its collections name this preset on their
				// loader macros. Depth-2 merge means unstated keys INHERIT the docs base above — and the
				// playground must rely on NOTHING of ours (its own shell, its own themes: the whole
				// point of the sub-layout split). So the preset restates EVERY key the base sets —
				// stock Shiki themes, stock defaults, no docs transformers, no changelog remark — making
				// it byte-equivalent to the standalone playground's pipeline (defaults + overrides). A
				// future edit to the docs base above can never reach it.
				presets: {
					playground: {
						markdown: {
							overrides: true,
							themes: { light: 'github-light', dark: 'github-dark' },
							defaultColor: 'light-dark()',
							wrapperClass: 'code-only',
							code: {},
							remark: [],
						},
					},
				},
			},
		}),
		sveltekit(),
	],
});
