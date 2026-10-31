import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { router } from '@ogygia/router/vite';
import { defineConfig } from 'vite';

// @ogygia/router's e2e fixture app: the server router behind /rtr (and the distributed table
// repro-island-pkg ships, e2e/island-pkg).
export default defineConfig({
	plugins: [ogygia({ plugins: [router()] }), sveltekit()]
});
