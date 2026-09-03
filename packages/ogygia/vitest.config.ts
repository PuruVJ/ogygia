import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';

// Two projects, one config:
//
// - `node`   — unit tests for the library internals (the transform, the content pipeline, the pure
//              runtime modules). They import the BUILT `dist/` output, so root `pnpm run check` builds
//              the lib before invoking `vitest run` (via the package `check` script).
// - `browser` — island tests in a REAL browser (Vitest browser mode, Playwright chromium). `setup.ts`
//              server-renders the fixture islands in Node and `provide()`s the HTML; each test drops
//              it into the document, boots the real runtime, and watches the island wake. No jsdom:
//              the runtime is a custom element + `hydrate()`, and only a browser tells the truth.
//
// vitest 4 pairs with vite 8 / Rolldown — its `vite` peer range is `^6 || ^7 || ^8`, verified
// empirically against the workspace vite 8.2.0.
export default defineConfig({
	// Some suites import library SOURCE (the content pipeline), which now transitively reaches `.svelte`
	// files (e.g. `RenderSnippet.svelte` behind the region-snippet capture). The Svelte plugin lets those
	// parse; dist-importing suites are unaffected (they resolve `.js`). The browser project needs it for
	// the island fixtures (client compile) and their SSR twin in `setup.ts` (server compile).
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
			'virtual:ogygia/router-config': fileURLToPath(new URL('./test/_stubs/virtual-router-config.ts', import.meta.url)),
			'virtual:ogygia/profiler-config': fileURLToPath(new URL('./test/_stubs/virtual-profiler-config.ts', import.meta.url)),
			'virtual:ogygia/dev-hmr-url': fileURLToPath(new URL('./test/_stubs/virtual-dev-hmr-url.ts', import.meta.url)),
			'virtual:ogygia/island-deps': fileURLToPath(new URL('./test/_stubs/virtual-island-deps.ts', import.meta.url)),
			'virtual:ogygia/kit-wire': fileURLToPath(new URL('./test/_stubs/virtual-kit-wire.ts', import.meta.url)),
			'virtual:ogygia/region-endpoint': fileURLToPath(new URL('./test/_stubs/virtual-region-endpoint.ts', import.meta.url)),
			'virtual:ogygia/request-event': fileURLToPath(new URL('./test/_stubs/virtual-request-event.ts', import.meta.url)),
			'virtual:ogygia/route-csr': fileURLToPath(new URL('./test/_stubs/virtual-route-csr.ts', import.meta.url)),
			// The browser runtime (`runtime/core.ts` → `app-transport.ts`) reads the app's transport codecs.
			'virtual:ogygia/transport': fileURLToPath(new URL('./test/_stubs/virtual-transport.ts', import.meta.url))
		}
	},
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'node',
					include: ['test/**/*.test.ts'],
					exclude: ['test/browser/**', '**/node_modules/**'],
					environment: 'node'
				}
			},
			{
				extends: true,
				test: {
					name: 'browser',
					include: ['test/browser/**/*.test.ts'],
					globalSetup: ['./test/browser/setup.ts'],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						instances: [{ browser: 'chromium' }]
					}
				}
			}
		]
	}
});
