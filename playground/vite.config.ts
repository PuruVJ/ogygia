import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// ogygia MUST run before sveltekit() (enforce:'pre' also guarantees ordering)
	plugins: [
		ogygia({
			// global default rootMargin for every `hydrate: 'visible'` island (per-import wins)
			visible: { margin: '0px' },
			// named presets referenced from imports via `with { preset: 'chart' }`
			presets: {
				chart: { hydrate: 'visible', margin: '200px' },
				// hydrate:none remount policy (default cache if omitted)
				frozen: { hydrate: 'none' },
				frozenSwr: { hydrate: 'none', remount: { strategy: 'swr', when: 'load' } },
				frozenEmpty: { hydrate: 'none', remount: 'empty' }
			}
		}),
		sveltekit()
	]
});
