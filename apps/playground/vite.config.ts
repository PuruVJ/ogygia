import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// PROFILER_SOURCEMAPS=1 emits server .map files so ogygia/profiler maps bundled frames back
	// to source and recovers anonymous names,. Off by default.
	build: process.env.PROFILER_SOURCEMAPS ? { sourcemap: true } : undefined,
	// ogygia MUST run before sveltekit() (enforce:'pre' also guarantees ordering)
	plugins: [
		ogygia({
			// Markdown content pipeline (stock defaults) so the `.svx` fixture behind e2e/content-css
			// compiles — that check guards content-body scoped CSS shipping to a csr=false page.
			content: { markdown: {} },
			regions: {
				// global default rootMargin for every `wake: 'visible'` island (per-import wins)
				visible: { margin: '0px' },
				// named presets referenced from imports via `with { preset: 'chart' }`
				presets: {
					chart: { wake: 'visible', margin: '200px' },
					// a frozen static lake (no revalidate)
					frozen: { wake: 'none' },
					// render: live — baked static content that revalidates (was the swr lake)
					frozenSwr: { render: 'live', wake: 'load' },
					// a deferred hole that opts INTO a browser cache (default is no-store): 1h max-age,
					// signed into the endpoint. Exercised by verify/server-islands.ts.
					cachedGreeting: { render: 'deferred', maxAge: '1h' }
				}
			}
		}),
		sveltekit()
	]
});
