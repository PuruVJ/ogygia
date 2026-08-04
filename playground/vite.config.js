import { sveltekit } from '@sveltejs/kit/vite';
import { skIslands } from 'sk-islands/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// sk-islands MUST run before sveltekit() (enforce:'pre' also guarantees ordering)
	plugins: [skIslands(), sveltekit()]
});
