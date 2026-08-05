import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		ogygia({
			visible: { margin: '120px' },
			presets: {
				demo: { hydrate: 'visible', margin: '200px' }
			}
		}),
		sveltekit()
	]
});
