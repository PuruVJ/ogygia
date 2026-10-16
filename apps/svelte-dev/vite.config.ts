import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-vercel';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';
import { imagetools } from 'vite-imagetools';
import { defineConfig } from 'vite';
import { createCssVariablesTheme } from 'shiki';
import { rehypeAdmonitions } from './src/lib/markdown/admonitions.ts';
import { inline_markers } from 'ogygia/content/markdown';
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

/** SvelteKit's config (Kit 3: passed to `sveltekit()`; a `svelte.config.js` is an error). A function:
 *  `ogygia.extensions()` / `.preprocess()` read the `ogygia({ content })` call, so it runs after it. */
const kit = () => ({
	adapter: adapter({ runtime: 'nodejs22.x' }),
	extensions: ogygia.extensions(),
	preprocess: [vitePreprocess(), ...ogygia.preprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	experimental: { remoteFunctions: true },
	prerender: {
		// Upstream docs prose links svelte.dev routes we deliberately don't build (the tutorial /
		// playground / blog apps), and cross-doc links in THEIR flattened URL scheme
		// (`/docs/kit/<page>` — no section segment; ours keeps sections until the outline slug
		// policy adopts flattened addresses). Warn-skip those; anything else still fails the build.
		handleHttpError({ status, path, referrer, message }: { status: number; path: string; referrer: string | null; message: string }) {
			// NB: /blog is OURS now (a real prerendered section) — a broken blog link fails the build.
			// Old posts additionally reference the repl/examples apps and in-repo media assets.
			// Flattened-scheme /docs links are REAL now (the flat-alias layer 308s them) — a 404
			// under /docs is a genuinely dead link and fails the build.
			const out_of_scope =
				/^\/(tutorial|playground|packages|chat|search|examples|repl|media|faq|apps|roadmap)(\/|$)/.test(path);
			if (status === 404 && out_of_scope) return;
			// The blog is an 8-year ARCHIVE: old posts link legacy doc schemes (`/docs/svelte-components`)
			// that are dead on svelte.dev too without their historical redirect map. Warn, don't fail —
			// but a dead /docs link from a DOCS page still fails the build (the corpus is live).
			if (status === 404 && /^\/blog\//.test(referrer ?? '')) {
				console.warn(`[prerender] skipped (legacy link in archived post): ${path} ← ${referrer}`);
				return;
			}
			throw new Error(message);
		},
		// Upstream anchors use svelte.dev's heading-id scheme; ours are scoped slugs. Warn, don't fail.
		handleMissingId({ id, path }: { id: string; path: string }) {
			console.warn(`[prerender] missing anchor (their id scheme): #${id} on ${path}`);
		}
	}
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
							inline_markers({ classes: { add: 'highlight add', remove: 'highlight remove' } }),
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
		sveltekit(kit())
	]
});
