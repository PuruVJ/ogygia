import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { imagetools } from 'vite-imagetools';
import { defineConfig } from 'vite';
import { createCssVariablesTheme } from 'shiki';
import { rehypeAdmonitions } from './src/lib/markdown/admonitions.ts';
import { inline_markers } from './src/lib/markdown/inline-markers.ts';
import { expandTypes } from './src/lib/markdown/expand-types.ts';
import { infostring, slash_meta } from 'ogygia/content/markdown';
import { js_to_ts } from './src/lib/markdown/js-to-ts.ts';
import { twoslash_banner, twoslash_ts, twoslash_svelte, twoslash_popup_markdown } from './src/lib/markdown/twoslash.ts';

// svelte-dev — the svelte.dev stress test. Its docs come from the ACTUAL source repos via
// `import.meta.og.loader.git()` (see src/lib/topics.ts). Everything svelte.dev-specific is a
// VALUE plugged into ogygia's contracts: the css-variables Shiki theme (tokens.css supplies the
// `--shiki-*` palette), the admonition rehype pass, the `+++/---` marker transformer, `/// file:`
// meta, and the JS↔TS variant generator.
const cssVariables = createCssVariablesTheme({
	name: 'css-variables',
	variablePrefix: '--shiki-',
	fontStyle: true
});

export default defineConfig({
	resolve: { dedupe: ['@sveltejs/kit'] },
	plugins: [
		// The hero machine: multi-format responsive sources, exactly svelte.dev's setup.
		imagetools(),
		ogygia({
			content: {
				markdown: {
					// The corpus is pure-static markdown → serialized regions: each doc compiles to one
					// plain-HTML string (data, not template source), bodies arrive pre-baked, and the
					// fence cache holds plain HTML.
					region: true,
					// One theme, driven by CSS custom properties — light/dark flip in tokens.css, so the
					// highlighted HTML is theme-free (exactly svelte.dev's model).
					themes: { light: cssVariables, dark: cssVariables },
					defaultColor: 'light',
					// `enforce: 'pre'` — the expanded reference sections (headings, fences) flow through
					// the TOC/anchor/code-id/link passes exactly as if hand-authored.
					remark: [{ enforce: 'pre', plugin: expandTypes }],
					rehype: [rehypeAdmonitions],
					code: {
						// Transformer ORDER matters (Shiki runs preprocess in array order, postprocess too):
						//  1. inline_markers: `+++/---` delimiters → space runs (twoslash-safe), wrapped back
						//     into highlight spans in its postprocess — composes with twoslash's rewriting.
						//  2. twoslash_banner: prepend ambient svelte/kit/$lib/$types globals + `---cut---`
						//  3/4. twoslash (js/ts) + twoslash-svelte — lang-filtered, re-entrancy-guarded
						//  5. twoslash_popup_markdown (postprocess LAST): render hover JSDoc as markdown
						// No twoslash_strip: twoslash CONSUMES `@errors`/`@filename`/`@noErrors`/`---cut---`.
						transformers: [
							inline_markers(),
							twoslash_banner(),
							twoslash_ts(),
							twoslash_svelte(),
							twoslash_popup_markdown()
						],
						meta: [infostring(), slash_meta()],
						variants: [js_to_ts()],
						cacheSalt: 'sd-twoslash3'
					}
				}
			}
		}),
		sveltekit()
	]
});
