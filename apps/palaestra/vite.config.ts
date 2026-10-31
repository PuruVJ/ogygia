import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig } from 'vite';

// THE PALAESTRA: core's e2e fixture app (its suite: e2e/, `pnpm turbo run e2e --filter=palaestra`).
// It lists NO plugin on purpose — every plugin's pages live in that plugin's own fixture app
// (packages/<plugin>/e2e/app), so a plugin change never reruns this suite.
export default defineConfig({
	// The e2e suite builds this app (adapter-vercel writes `.vercel/output`, a copy of the server's whole
	// dependency tree), then starts dev servers in the same folder. Vite's watcher skips only
	// `node_modules` / `.git`: on Linux (one inotify watcher per directory) it crawled 126k directories of
	// that output, grew to 3.4 GB and never became ready on CI. The build output is not source.
	server: { watch: { ignored: ['**/.vercel/**'] } },
	// ogygia MUST run before sveltekit() (enforce:'pre' also guarantees ordering)
	plugins: [
		ogygia({
			// The debarrel pass, ON for the whole palaestra: every e2e run builds and serves the app the
			// way a customer with `barrels: true` does. REGRESSION (customer build, 2026-09-15): the pass
			// rewrote `import { Ticker } from '$lib/barrel'` fed to `asRegion(Ticker)` into a leaf import,
			// the transform minted a different island id from the one the prescan derived from the raw
			// file, and the server manifest imported a virtual entry nobody registered ("Rolldown failed
			// to resolve import virtual:ogygia/island/<id>.js from virtual:ogygia/server-manifest"). The
			// /as-region and /ts-registry fixtures are that shape; with this on, the build is the test.
			barrels: true,
			// Opt IN to server-delta nav (off by default) so e2e/server-delta.ts exercises the protocol:
			// an SPA nav sends `x-ogygia-known`, the server skips re-rendering the island the client keeps.
			router: { serverDelta: true },
			// global default rootMargin for every `wake: 'visible'` region (per-import wins)
			visible: { margin: '0px' },
			// named presets referenced from imports via `with { preset: 'chart' }`
			presets: {
				chart: { wake: 'visible', margin: '200px' },
				// a frozen static lake (no revalidate)
				frozen: { wake: 'none' },
				// render: live — baked static content that revalidates (was the swr lake)
				frozenSwr: { render: 'live', wake: 'load' },
				// a deferred hole that opts INTO a browser cache (default is no-store): 1h max-age,
				// signed into the endpoint. Exercised by e2e/server-islands.spec.ts. (`fetch` spelled out:
				// a preset with a hole's timing must build — 0.10.0 rejected the key.)
				cachedGreeting: { render: 'deferred', fetch: 'load', maxAge: '1h' }
			}
		}),
		sveltekit()
	]
});
