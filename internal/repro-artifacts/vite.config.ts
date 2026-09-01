import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// The artifacts fixture: `artifacts: true` = the whole adoption (tier-1 memory store;
	// e2e/artifacts.ts wires edge adapters at the emulators through hooks.server.ts).
	plugins: [ogygia({ artifacts: true }), sveltekit()]
});
