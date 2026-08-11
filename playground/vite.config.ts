import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// ogygia MUST run before sveltekit() (enforce:'pre' also guarantees ordering)
	plugins: [
		ogygia({
			// global default rootMargin for every `wake: 'visible'` island (per-import wins)
			visible: { margin: '0px' },
			// CONTINUITY: ambient form survival (default on) + native next-page speculation on hover.
			continuity: { speculate: 'hover' },
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
		}),
		sveltekit()
	]
});
