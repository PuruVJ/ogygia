import { createRequire } from 'node:module';
import { sveltekit } from '@sveltejs/kit/vite';
import { ogygia } from 'ogygia/vite';
import { diff_markers, inline_markers } from 'ogygia/content/markdown';
import { defineConfig, type Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import { observatoryNodeShims } from './observatory-node-shims';
import { load_ogygia_themes } from './src/lib/code/shiki-themes.js';
import { remarkChangelog } from './src/lib/remark-changelog.js';
import { expandApi, expandApiCacheKey, expandApiDependencies } from './src/lib/api-ref/expand-api.ts';

const require = createRequire(import.meta.url);

// Custom site Shiki themes (forest neutrals + green) — the same ogygia-light / ogygia-dark used by
// the snippets highlighter, so .svx fences match hand-highlighted code.
const themes = await load_ogygia_themes();

// ── Observatory (the in-browser REPL at /observatory) needs a browser build of rolldown's oxc WASM ──
// rolldown-browser's `./utils` subpath resolves to the NODE wasi binding; force the BROWSER variant.
const RB_UTILS_BROWSER = require
	.resolve('@rolldown/browser/package.json')
	.replace(/package\.json$/, 'dist/utils-index.browser.mjs');

// The WASM uses SharedArrayBuffer (WASI worker-threads) → needs cross-origin isolation. Scoped to the
// Observatory routes ONLY, so the rest of the docs site (cross-origin embeds etc.) is never constrained.
const crossOriginIsolation = (): Plugin => {
	const headers = (_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
		// App-wide in DEV: the isolated document AND its worker script + WASM chunk (served from /src or
		// /@id, not /observatory) all need require-corp, or the worker is ERR_BLOCKED_BY_RESPONSE. The docs
		// site is all same-origin (verified — same-origin iframes/fonts/OG), so app-wide isolation is safe
		// here. Prod headers (scoped to /observatory*) live in hooks.server.ts.
		res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
		res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
		res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
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

// Plugins live here; Kit config (adapter, extensions, preprocess) lives in svelte.config.js — the
// Kit v2 home that `svelte-check` and the editor's Svelte language server read. The ogygia() plugin
// registers its markdown config synchronously here (before sveltekit() loads svelte.config.js), so
// the value-free `ogygia.extensions()` / `ogygia.preprocess()` in svelte.config.js resolve to the
// full markdown + island pipeline for the build.
export default defineConfig({
	resolve: {
		// Observatory: browser variant of rolldown's ./utils (WASI worker-threads binding).
		alias: { '@rolldown/browser/utils': RB_UTILS_BROWSER }
	},
	// @neodrag/svelte (the Observatory's splitpane / DnD) ships `$state` runes in `.svelte.js` modules.
	// Vite externalizes node_modules for SSR by default, so Svelte never compiles them → `$state` is
	// undefined at render → 500. noExternal routes the package through the Svelte SSR transform.
	ssr: { noExternal: ['@neodrag/svelte'] },
	// Observatory: CodeMirror is imported inside a code-split island, so Vite's cold scan misses it and
	// re-optimizes at runtime (a dev reload loop + 504s). Pre-bundle the direct CM6 deps upfront.
	optimizeDeps: {
		include: [
			'@codemirror/state',
			'@codemirror/view',
			'@codemirror/commands',
			'@codemirror/language',
			'@codemirror/lang-javascript',
			'@codemirror/lang-html',
			'@replit/codemirror-lang-svelte',
			'@codemirror/autocomplete',
			'@lezer/highlight',
			// neodrag splitpane / sortable / drop — imported inside the code-split Observatory island, so
			// the cold scan misses them and re-optimizes at runtime (a reload that races the Kit runtime
			// into a TDZ crash). Pre-bundle them upfront; vite-plugin-svelte's esbuild plugin compiles the
			// `.svelte.js` runes modules during optimize.
			'@neodrag/svelte/splitpane',
			'@neodrag/svelte/sortable',
			'@neodrag/svelte/drop',
			// Prettier (the Observatory's Format button) is dynamic-imported on hover → a lazy chunk. Pre-
			// bundle it so dev doesn't re-optimize+reload on first hover; the runtime fetch stays lazy.
			'prettier/standalone',
			'prettier-plugin-svelte',
			'prettier/plugins/estree',
			'prettier/plugins/babel',
			'prettier/plugins/typescript',
			'prettier/plugins/html',
			'prettier/plugins/postcss',
			// The FULL browser compiler driver (Observatory). It MUST be pre-bundled (esbuild), not served
			// as source modules: Vite's dev transform injects its HMR client wrapper (which references
			// `window`) into each source module, and the Observatory imports the driver in a WEB WORKER
			// where `window` is undefined → the worker dies at load. Pre-bundling emits one plain module,
			// no per-module HMR. (`bake` is now lazy-imported, so its Node-only dynamic imports no longer
			// enter this graph — which is what used to make pre-bundling double-declare `__vite__injectQuery`.)
			'ogygia/internal/compiler-browser-full'
		]
	},
	// PROFILER_SOURCEMAPS=1 pnpm build → server chunks get .map files, so the SSR profiler
	// (ogygia/profiler) maps bundled frames back to source files and recovers original
	// names for anonymous functions. `target: 'esnext'` is required for the Observatory worker's
	// top-level-await (rolldown WASM); it raises the browser baseline for the whole site (modern only).
	build: { target: 'esnext', ...(process.env.PROFILER_SOURCEMAPS ? { sourcemap: true } : {}) },
	worker: {
		format: 'es',
		// The nested WASI worker (wasi-worker.mjs) imports node:module — needs the shims here too.
		plugins: () => [observatoryNodeShims(), wasm()]
	},
	plugins: [
		// Observatory: node shims (client/worker only — SSR keeps real node builtins), COOP/COEP on the
		// /observatory routes, and the WASM asset loader. Before ogygia() (enforce:'pre' also orders them).
		observatoryNodeShims(),
		crossOriginIsolation(),
		wasm(),
		ogygia({
			regions: {
				visible: { margin: '120px' },
				presets: {
					demo: { wake: 'visible', margin: '200px' },
					frozenSwr: { render: 'live', wake: 'load' },
				},
			},
			content: {
				markdown: {
					themes: { light: themes.light, dark: themes.dark },
					defaultColor: 'light-dark()',
					wrapperClass: 'code-only',
					// The two diff dialects (line `+++ `/`--- ` prefixes + inline `+++x+++`/`---x---`),
					// dogfooded on the markdown-authoring page.
					code: { transformers: [diff_markers(), inline_markers()] },
					// Reshape the Releases page's `## [x] — date` headings into a clean version + a date
					// line under it. `enforce: 'pre'` so the heading-id/TOC collectors see "0.5.0".
					// expandApi: `> MODULE: ogygia/…` → the auto-generated API reference, regenerated from
					// the package's own d.ts on every build — cache_key re-keys the doc cache when the
					// d.ts set changes; dependencies lets Vite recompile affected pages in dev.
					remark: [
						{ enforce: 'pre', plugin: remarkChangelog },
						{
							enforce: 'pre',
							plugin: expandApi,
							cache_key: expandApiCacheKey,
							dependencies: expandApiDependencies,
						},
					],
				},
				// The /playground sub-app's markdown variant: its collections name this preset on their
				// loader macros. Depth-2 merge means unstated keys INHERIT the docs base above — and the
				// playground must rely on NOTHING of ours (its own shell, its own themes: the whole
				// point of the sub-layout split). So the preset restates EVERY key the base sets —
				// stock Shiki themes, stock defaults, no docs transformers, no changelog remark — making
				// it byte-equivalent to the standalone playground's pipeline (defaults + overrides). A
				// future edit to the docs base above can never reach it.
				presets: {
					playground: {
						markdown: {
							overrides: true,
							themes: { light: 'github-light', dark: 'github-dark' },
							defaultColor: 'light-dark()',
							wrapperClass: 'code-only',
							code: {},
							remark: [],
						},
					},
				},
			},
		}),
		sveltekit(),
	],
});
