import { sveltekit } from '@sveltejs/kit/vite';
import { skIslands } from 'sk-islands/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// sk-islands MUST run before sveltekit() (enforce:'pre' also guarantees ordering)
	plugins: [
		skIslands({
			// global default rootMargin for every `hydrate: 'visible'` island (per-import wins)
			visible: { margin: '0px' },
			// named presets referenced from imports via `with { preset: 'chart' }`
			presets: {
				chart: { hydrate: 'visible', margin: '200px' }
			}
		}),
		sveltekit()
	]
});
