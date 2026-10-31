import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { freeze } from '@ogygia/freeze/vite';
import { flags } from '@ogygia/flags/vite';
import { router } from '@ogygia/router/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// The freeze fixture: `freeze()` = the whole adoption (tier-1 memory store;
	// e2e/freeze.ts wires edge adapters at the emulators through hooks.server.ts). `flags()`: the
	// /flagged page reads one, and that read must refuse the store. `router()`: the /r/* pages are a
	// server-router table in hooks.server.ts.
	plugins: [ogygia({ plugins: [freeze(), flags(), router()] }), sveltekit()]
});
