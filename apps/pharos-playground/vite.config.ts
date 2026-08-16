import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

// ogygia MUST run before sveltekit(). `content.markdown` turns on the .svx pipeline (mdsvex +
// islands), so guides can host live components mid-prose — the ogygia "dialect" primitive.
export default defineConfig({
	// Dedupe kit so a 404 the LIB throws (running from src in dev) is the SAME HttpError class the app
	// recognizes — otherwise a not-found renders as 500 in dev (prod bundles one kit, so it's fine).
	resolve: { dedupe: ['@sveltejs/kit'] },
	plugins: [
		ogygia({
			visible: { margin: '120px' },
			// `overrides` wraps a/img/code in the ogygia slot; the ogygia site's component map (default
			// `a → Link`) then makes plain markdown links id-form + redirect-aware, no author markup.
			content: { markdown: { overrides: true } }
		}),
		sveltekit()
	]
});
