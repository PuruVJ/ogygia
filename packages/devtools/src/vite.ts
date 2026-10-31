/**
 * `devtools()` — the in-page dock and the SSR profiler, listed beside `ogygia()`
 * in vite.config. List it only where you want it:
 *
 *   plugins: [...(mode !== 'production' ? [devtools({ profiler: true })] : [])]
 *
 * - `dock` (default true): core's events compiled in, browser and server, and the dock that reads
 *   them (Alt+O). In a build the pages carry only a small launcher: the dock's code loads when
 *   someone opens it, and the page is measured from the next load on.
 * - `profiler` (default off): `true` or its options. The server half wraps every request, times the
 *   render and serves its UI at `/__profiler`; the build records what it reads (maps, island
 *   detail). Its secret defaults to the OGYGIA_PROFILER_SECRET env var at runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import type { Plugin as VitePlugin, UserConfig } from 'vite';
import { definePlugin, type OgygiaPlugin } from '@ogygia/core/vite';
import type { ProfilerOptions } from './profiler/index.ts';
import type { DevtoolsServerOptions } from './server.ts';

export type { ProfilerOptions };

export interface DevtoolsOptions {
	/** The dock and core's events (default true). */
	dock?: boolean;
	/** The SSR profiler: `true` or its options (default off). */
	profiler?: boolean | ProfilerOptions;
}

/** this package's directory (from `dist/vite.js` or `src/vite.ts`) */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** the workspace checkout ships `src`; an install, `dist` */
const FROM_SRC = fs.existsSync(path.join(PKG_ROOT, 'src/profiler/profiler-router.ts'));
const posix = (p: string) => p.split(path.sep).join('/');
/** the server half's dynamic import of the profiler (src `.ts` or built `.js`) */
const PROFILER_IMPORT_RE = /import\((['"])\.\/profiler\/index\.(ts|js)\1\)/;

export function devtools(
	options: DevtoolsOptions = {}
): [OgygiaPlugin<DevtoolsServerOptions>, VitePlugin] {
	const dock = options.dock !== false;
	const profiler: ProfilerOptions | null = options.profiler
		? options.profiler === true
			? {}
			: { ...options.profiler }
		: null;
	const plugin = definePlugin<DevtoolsServerOptions>({
		name: '@ogygia/devtools',
		server: import.meta.resolve('./server.ts'),
		client: import.meta.resolve('./client.ts'),
		options: { profiler },
		build(b) {
			if (dock) b.events({ lazy: !b.dev });
			if (profiler) {
				b.measure();
				// the profiler UI: real islands, rendered only from its handle (no app file marks them), and
				// its server router — a page module, whose page components' scoped styles ride router-css
				const profiler_router = path.join(
					PKG_ROOT,
					FROM_SRC ? 'src/profiler/profiler-router.ts' : 'dist/profiler/profiler-router.js'
				);
				b.files({
					root: PKG_ROOT,
					dirs: [path.join(PKG_ROOT, FROM_SRC ? 'src/profiler/ui' : 'dist/profiler/ui')],
					files: [profiler_router]
				});
				b.pageModules({ files: [profiler_router] });
			}
		}
	});
	return [plugin, devtools_vite(dock, profiler)];
}

/** The plugin's own Vite side: its client dependencies for the dev optimizer, the build warnings, and
 *  the dev CSS-crawl guard on its server half. */
function devtools_vite(dock: boolean, profiler: ProfilerOptions | null): VitePlugin {
	// the server half, as the ids Vite hands the transform hook (either copy)
	const server_ids = new Set([
		posix(path.join(PKG_ROOT, 'src/server.ts')),
		posix(path.join(PKG_ROOT, 'dist/server.js'))
	]);
	let dev = false;
	return {
		name: 'ogygia:devtools',
		enforce: 'pre',
		config(_config, env) {
			dev = env.command === 'serve';
			if (env.command === 'build' && isMainThread) {
				// said once, loudly, so a dock left on by accident is seen before it ships
				if (dock)
					console.warn(
						'[ogygia] devtools is ON for this build: its pages carry the devtools launcher (the dock ' +
							"loads only when opened). Keep it off for production: list `devtools()` only when `mode !== 'production'`."
					);
				// an explicit `secret` that is EMPTY at build time: the author meant to bake it, the build env
				// lacked the variable, and the UI ends up disabled in production (Amplify, Lambda)
				if (profiler && 'secret' in profiler && !profiler.secret)
					console.warn(
						'[ogygia] profiler: `profiler.secret` is EMPTY in this build — the variable it reads is not set ' +
							'in the BUILD environment. The UI will be DISABLED in production unless OGYGIA_PROFILER_SECRET ' +
							'exists at runtime (on Amplify / Lambda it does not): /__profiler will answer "installed but ' +
							'disabled". Set the variable where the build runs, and keep the `profiler` option unconditional.'
					);
			}
			// the dock's drag and resize, named through this package (under a strict install the app cannot
			// resolve them bare): found late in dev, each re-optimized and reloaded the page
			const out: UserConfig = {};
			if (dock && env.command === 'serve')
				out.optimizeDeps = {
					include: [
						'@ogygia/devtools > @neodrag/svelte',
						'@ogygia/devtools > @neodrag/svelte/resize'
					]
				};
			// the profiler is built on the server router, which ships `.svelte`: server-inlined like a listed
			// plugin even when the app does not list `router()` itself
			if (profiler) out.ssr = { noExternal: ['@ogygia/router'] };
			return out;
		},
		transform(code, id, opts) {
			// DEV ONLY: sever the server half → profiler EDGE from Vite's import analysis. Kit's dev "inline
			// all styles" crawl walks every recorded dependency (dynamic included) from the app's hooks, and
			// the profiler UI carries real stylesheets: a literal `import('./profiler/index.ts')` here would
			// inline them into EVERY dev page. An opaque specifier records no edge, while the runner still
			// resolves it importer-relative at request time. Builds keep the literal (rolldown bundles it).
			if (!dev || !opts?.ssr || !server_ids.has(id.split('?')[0])) return null;
			return {
				code: code.replace(
					PROFILER_IMPORT_RE,
					'import(/* @vite-ignore */ ((s) => s)($1./profiler/index.$2$1))'
				),
				map: null
			};
		}
	};
}
