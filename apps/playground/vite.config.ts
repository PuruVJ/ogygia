import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { flags } from '@ogygia/flags/vite';
import { content } from '@ogygia/content/vite';
import { devtools } from '@ogygia/devtools/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// (the profiler's server build writes hidden maps by itself; PROFILER_NO_SOURCEMAPS=1 builds without
	// any, the way an app that turned them off does — what the answer key's `--no-maps` measures)
	build: {
		...(process.env.PROFILER_SOURCEMAPS ? { sourcemap: true } : {}),
		...(process.env.PROFILER_NO_SOURCEMAPS ? { sourcemap: false } : {})
	},
	// The e2e suite builds this app (adapter-vercel writes `.vercel/output`, a copy of the server's whole
	// dependency tree), then starts dev servers in the same folder. Vite's watcher skips only
	// `node_modules` / `.git`: on Linux (one inotify watcher per directory) it crawled 126k directories of
	// that output, grew to 3.4 GB and never became ready on CI. The build output is not source.
	server: { watch: { ignored: ['**/.vercel/**'] } },
	// ogygia MUST run before sveltekit() (enforce:'pre' also guarantees ordering)
	plugins: [
		ogygia({
			// The debarrel pass, ON for the whole playground: every e2e run builds and serves the app the
			// way a customer with `barrels: true` does. REGRESSION (customer build, 2026-09-15): the pass
			// rewrote `import { Ticker } from '$lib/barrel'` fed to `asRegion(Ticker)` into a leaf import,
			// the transform minted a different island id from the one the prescan derived from the raw
			// file, and the server manifest imported a virtual entry nobody registered ("Rolldown failed
			// to resolve import virtual:ogygia/island/<id>.js from virtual:ogygia/server-manifest"). The
			// /as-region and /ts-registry fixtures are that shape; with this on, the build is the test.
			barrels: true,
			// Plugins (internal/notes/packages.md): every e2e request runs through the plugin stages.
			// content: the markdown pipeline (stock defaults) so the `.svx` fixture behind
			// e2e/content-css compiles — that check guards content-body scoped CSS shipping to a
			// csr=false page.
			// devtools: the SSR profiler, always (its UI islands build, its handle mounts it; secret from
			// OGYGIA_PROFILER_SECRET at runtime; + the background recorders the hell page exercises: a trap
			// for any request over 400 ms, a 1 s coarse sample every 20 s; serverTiming on in the built
			// preview too, so the hell page's own API routes answer the profiler's nested-trace ask). The
			// DOCK (core's event layer) is OFF by default — so the suite + bundle-size snapshot stay honest
			// and e2e/devtools.ts proves tree-shaking — and on with OGYGIA_DEVTOOLS=1.
			plugins: [
				flags(),
				content({ markdown: {} }),
				devtools({
					dock: !!process.env.OGYGIA_DEVTOOLS,
					profiler: { trap: { over: 400, keep: 3 }, sample: { every: 20, window: 1000 }, serverTiming: true }
				})
			],
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
				// signed into the endpoint. Exercised by verify/server-islands.ts. (`fetch` spelled out: a
				// preset with a hole's timing must build — 0.10.0 rejected the key.)
				cachedGreeting: { render: 'deferred', fetch: 'load', maxAge: '1h' },
				// the hell page's second recommendations hole: a render cache the profiler's hole
				// economics can watch (hits vs misses)
				cachedRecs: { render: 'deferred', maxAge: '5m' }
			}
		}),
		sveltekit()
	]
});
