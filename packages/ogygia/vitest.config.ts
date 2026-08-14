import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// Unit tests for the pure library internals (the transform). They import the BUILT
// `dist/` output, so root `pnpm run check` builds the lib before invoking `vitest run`
// (via the package `check` script). vitest 4 pairs with vite 8 / Rolldown — its `vite`
// peer range is `^6 || ^7 || ^8`, verified empirically against the workspace vite 8.2.0.
export default defineConfig({
	// Some suites import library SOURCE (the content pipeline), which now transitively reaches `.svelte`
	// files (e.g. `RenderSnippet.svelte` behind the region-snippet capture). The Svelte plugin lets those
	// parse; dist-importing suites are unaffected (they resolve `.js`).
	plugins: [svelte()],
	resolve: {
		alias: { '$app/server': fileURLToPath(new URL('./test/_stubs/app-server.ts', import.meta.url)) }
	},
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node'
	}
});
