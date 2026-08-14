import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { ogygia } from 'ogygia/vite';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: ogygia.extensions(),
	preprocess: [vitePreprocess(), ...ogygia.preprocess()],
	compilerOptions: {
		experimental: { async: true }
	},
	kit: {
		adapter: adapter(),
		experimental: { remoteFunctions: true },
		prerender: {
			// Upstream docs prose links svelte.dev routes we deliberately don't build (the tutorial /
			// playground / blog apps), and cross-doc links in THEIR flattened URL scheme
			// (`/docs/kit/<page>` — no section segment; ours keeps sections until the outline slug
			// policy adopts flattened addresses). Warn-skip those; anything else still fails the build.
			handleHttpError({ status, path, referrer, message }) {
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
			handleMissingId({ id, path }) {
				console.warn(`[prerender] missing anchor (their id scheme): #${id} on ${path}`);
			}
		}
	}
};

export default config;
