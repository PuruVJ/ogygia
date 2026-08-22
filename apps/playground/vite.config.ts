import { createRequire } from 'node:module';
import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import { observatoryNodeShims } from './observatory-node-shims';

const require = createRequire(import.meta.url);

// rolldown-browser's `./utils` subpath resolves to the NODE wasi binding; force the BROWSER variant
// (uses @napi-rs/wasm-runtime + memfs + WASI worker-threads). Resolved off package.json (exports-safe).
const RB_UTILS_BROWSER = require
	.resolve('@rolldown/browser/package.json')
	.replace(/package\.json$/, 'dist/utils-index.browser.mjs');

// The rolldown-browser WASM uses SHARED memory + WASI worker-threads → needs cross-origin isolation
// (SharedArrayBuffer). Send COOP/COEP on dev + preview so the Observatory's worker can instantiate it.
// (This is the "COOP/COEP hosting" cost internal/notes/devtools.md flags for in-browser stacks.)
const crossOriginIsolation = (): Plugin => {
	const headers = (_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
		res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
		res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
		next();
	};
	return {
		name: 'observatory-cross-origin-isolation',
		configureServer(server) {
			server.middlewares.use(headers as never);
		},
		configurePreviewServer(server) {
			server.middlewares.use(headers as never);
		}
	};
};

export default defineConfig({
	resolve: {
		alias: { '@rolldown/browser/utils': RB_UTILS_BROWSER }
	},
	// The Observatory worker instantiates rolldown-browser's oxc WASM (wasm32-wasi via
	// @napi-rs/wasm-runtime), which uses TOP-LEVEL AWAIT. Vite 8 supports TLA natively at the `esnext`
	// target (the vite-plugin-top-level-await shim is incompatible with Vite 8 / rolldown). vite-plugin-wasm
	// handles the .wasm asset. WORKER bundles have their own pipeline, so wasm() goes there too.
	build: {
		target: 'esnext',
		...(process.env.PROFILER_SOURCEMAPS ? { sourcemap: true } : {})
	},
	worker: {
		format: 'es',
		// The node-shims MUST be here too: rolldown-browser spawns a NESTED WASI worker
		// (wasi-worker.mjs) that imports `node:module` — nested workers use this pipeline, not the
		// main `plugins`, so without it `createRequire` throws.
		plugins: () => [observatoryNodeShims(), wasm()]
	},
	// ogygia MUST run before sveltekit() (enforce:'pre' also guarantees ordering)
	plugins: [
		observatoryNodeShims(),
		crossOriginIsolation(),
		wasm(),
		ogygia({
			// Markdown content pipeline (stock defaults) so the `.svx` fixture behind e2e/content-css
			// compiles — that check guards content-body scoped CSS shipping to a csr=false page.
			content: { markdown: {} },
			// DEVTOOLS event layer — OFF by default (so the suite + bundle-size snapshot stay honest and
			// e2e/devtools.ts proves tree-shaking); flip on with OGYGIA_DEVTOOLS=1 to run the event-driven
			// proof-of-value build. Env-gated, not always-on, precisely so the default build ships nothing.
			devtools: !!process.env.OGYGIA_DEVTOOLS,
			// Opt IN to server-delta nav (off by default) so e2e/server-delta.ts exercises the protocol:
			// an SPA nav sends `x-ogygia-known`, the server skips re-rendering the island the client keeps.
			router: { serverDelta: true },
			regions: {
				// global default rootMargin for every `wake: 'visible'` island (per-import wins)
				visible: { margin: '0px' },
				// named presets referenced from imports via `with { preset: 'chart' }`
				presets: {
					chart: { wake: 'visible', margin: '200px' },
					// a frozen static lake (no revalidate)
					frozen: { wake: 'none' },
					// render: live — baked static content that revalidates (was the swr lake)
					frozenSwr: { render: 'live', wake: 'load' },
					// a deferred hole that opts INTO a browser cache (default is no-store): 1h max-age,
					// signed into the endpoint. Exercised by verify/server-islands.ts.
					cachedGreeting: { render: 'deferred', maxAge: '1h' }
				}
			}
		}),
		sveltekit()
	]
});
