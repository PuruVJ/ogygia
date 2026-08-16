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
		alias: {
			'$app/server': fileURLToPath(new URL('./test/_stubs/app-server.ts', import.meta.url)),
			// The `ogygia/content` barrel now carries the site kit's shell components, whose graph
			// reads `$app/state` and (via Doc → Region.svelte) the plugin's virtual modules — stub
			// them so barrel-importing suites load without a Kit app or the Vite plugin.
			'$app/state': fileURLToPath(new URL('./test/_stubs/app-state.ts', import.meta.url)),
			'$app/paths': fileURLToPath(new URL('./test/_stubs/app-paths.ts', import.meta.url)),
			'$app/environment': fileURLToPath(new URL('./test/_stubs/app-environment.ts', import.meta.url)),
			'virtual:ogygia/runtime-url': fileURLToPath(new URL('./test/_stubs/virtual-runtime-url.ts', import.meta.url)),
			'virtual:ogygia/dev-hmr-url': fileURLToPath(new URL('./test/_stubs/virtual-dev-hmr-url.ts', import.meta.url)),
			'virtual:ogygia/island-deps': fileURLToPath(new URL('./test/_stubs/virtual-island-deps.ts', import.meta.url)),
			'virtual:ogygia/region-endpoint': fileURLToPath(new URL('./test/_stubs/virtual-region-endpoint.ts', import.meta.url)),
			'virtual:ogygia/request-event': fileURLToPath(new URL('./test/_stubs/virtual-request-event.ts', import.meta.url))
		}
	},
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node'
	}
});
