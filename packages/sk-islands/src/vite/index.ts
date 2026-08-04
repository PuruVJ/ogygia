import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transformHost, ISLAND_DIR } from './transform.js';
import { allRoutesCsrFalse, runStandaloneClientBuild } from './standalone.js';

const RUNTIME_ENTRY = fileURLToPath(new URL('../runtime/index.js', import.meta.url));

// Client-side shims aliased for island modules (Kit's client runtime is absent under csr=false).
const APP_SHIMS = {
	'$app/state': fileURLToPath(new URL('../shims/app-state.js', import.meta.url)),
	'$app/stores': fileURLToPath(new URL('../shims/app-stores.js', import.meta.url)),
	'$app/navigation': fileURLToPath(new URL('../shims/app-navigation.js', import.meta.url))
};

const REMOTE_CLIENT = fileURLToPath(new URL('../shims/remote-client.svelte.js', import.meta.url));

const V_RUNTIME_URL = 'virtual:ogygia/runtime-url';
const V_MANIFEST = 'virtual:ogygia/manifest';
const V_RUNTIME = 'virtual:ogygia-runtime';
const V_SECRET = 'virtual:ogygia/secret';
const V_SERVER_MANIFEST = 'virtual:ogygia/server-manifest';
const RESOLVED = (id) => '\0' + id;

const RUNTIME_FILENAME = '_app/immutable/ogygia-runtime.js';
const RUNTIME_URL_BUILD = '/' + RUNTIME_FILENAME;

function toPosix(p) {
	return p.split(path.sep).join('/');
}

function isIslandPath(id) {
	return id.includes('/' + ISLAND_DIR + '/') && id.endsWith('.svelte');
}

function isScriptPath(id) {
	return id.includes('/' + ISLAND_DIR + '/') && /\.script\.(js|ts)$/.test(id);
}

const SCRIPT_FILENAME = (hash) => `_app/immutable/sk-scripts/${hash}.js`;

/**
 * @param {Object} [options]
 * @param {boolean} [options.spa=true] enable the built-in SPA router
 * @param {{margin?:string}} [options.visible] global defaults for `hydrate: 'visible'` islands
 * @param {Record<string, {hydrate?:string, defer?:string, margin?:string}>} [options.presets]
 *   named strategy presets referenced from imports via `with { preset: 'name' }`
 * @param {boolean} [options.standalone] internal: this instance runs inside the standalone build
 * @returns {import('vite').Plugin}
 */
export function ogygia(options = {}) {
	const spa = options.spa !== false;
	const standalone = options.standalone === true;
	const visibleMargin = options.visible?.margin;
	const presets = options.presets || {};

	// HMAC key for signing server-island props. Runtime env var wins (so it can be rotated
	// / shared across instances in production); otherwise a per-build random key baked into
	// the SERVER bundle only (never a client chunk — see the `virtual:ogygia/secret` load).
	const buildSecret = crypto.randomBytes(32).toString('hex');

	/** @type {Map<string, {source:string, hostPath:string, id:string}>} keyed by abs virtual path */
	const registry = new Map();
	/** @type {Map<string, string>} iid -> abs virtual path */
	const byId = new Map();
	/** @type {Map<string, {source:string, hostPath:string, hash:string}>} bundled <script island> chunks */
	const scriptRegistry = new Map();

	let root;
	let base = '';
	let libDir;
	let isDev = false;
	let isBuild = false;
	let isSSR = false;
	let scanned = false;
	let sourcemap = false;
	let ranStandalone = false;

	const readFile = (abs) => {
		try {
			return fs.readFileSync(abs, 'utf-8');
		} catch {
			return null;
		}
	};

	const virtualPathFor = (hostId, iid) =>
		path.join(path.dirname(hostId), ISLAND_DIR, iid + '.svelte');

	const devUrlFor = (virtualPath) => {
		const rel = toPosix(path.relative(root, virtualPath));
		const prefix = base && base !== '/' ? base.replace(/\/$/, '') : '';
		return prefix + '/' + rel;
	};

	const scriptPathFor = (hostId, hash, ext) =>
		path.join(path.dirname(hostId), ISLAND_DIR, hash + '.script' + ext);

	const scriptUrlFor = (scriptPath, hash) => {
		const prefix = base && base !== '/' ? base.replace(/\/$/, '') : '';
		return isDev ? devUrlFor(scriptPath) : prefix + '/' + SCRIPT_FILENAME(hash);
	};

	const runTransform = (source, id) => {
		return transformHost(source, id, {
			root,
			libDir,
			readFile,
			pathModule: path,
			dev: isDev,
			virtualPathFor,
			devUrlFor,
			scriptPathFor,
			scriptUrlFor,
			visibleMargin,
			presets
		});
	};

	const register = (result) => {
		for (const isl of result.islands ?? []) {
			registry.set(isl.virtualPath, {
				source: isl.source,
				hostPath: isl.hostPath,
				id: isl.id,
				server: !!isl.server
			});
			byId.set(isl.id, isl.virtualPath);
		}
		for (const sc of result.scripts ?? []) {
			scriptRegistry.set(sc.scriptPath, { source: sc.source, hostPath: sc.hostPath, hash: sc.hash });
		}
	};

	/** Pre-scan every app .svelte so the build manifest is complete before it loads. */
	const prescan = () => {
		if (scanned) return;
		scanned = true;
		const srcDir = path.join(root, 'src');
		const walk = (dir) => {
			let entries;
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name === 'node_modules' || entry.name === ISLAND_DIR) continue;
					walk(full);
				} else if (entry.name.endsWith('.svelte')) {
					const src = readFile(full);
					if (src == null) continue;
					const result = runTransform(src, full);
					if (result) register(result);
				}
			}
		};
		walk(srcDir);
	};

	return {
		name: 'ogygia',
		enforce: 'pre',

		configResolved(config) {
			root = config.root;
			base = config.base || '';
			libDir = path.join(root, 'src', 'lib');
			isDev = config.command === 'serve';
			isBuild = config.command === 'build';
			isSSR = !!config.build?.ssr;
			sourcemap = !!config.build?.sourcemap;
		},

		buildStart() {
			// client build only: emit the runtime + bundled scripts as deterministic chunks.
			// In the standalone build the runtime is the rollup input (named via
			// entryFileNames), so we don't emit it there.
			if (isBuild && !isSSR) {
				prescan();
				if (!standalone) {
					this.emitFile({ type: 'chunk', id: RUNTIME_ENTRY, fileName: RUNTIME_FILENAME });
				}
				for (const [scriptPath, meta] of scriptRegistry) {
					this.emitFile({ type: 'chunk', id: scriptPath, fileName: SCRIPT_FILENAME(meta.hash) });
				}
			}
		},

		// After Kit's SSR build, if Kit will SKIP its client build (every route is
		// csr=false), run our own client build so islands still get bundled. Our
		// enforce:'pre' writeBundle runs before Kit's (which does the skip + prerender).
		writeBundle: {
			sequential: true,
			async handler() {
				if (standalone || ranStandalone) return;
				if (!isBuild || !isSSR) return;
				const routesDir = path.join(root, 'src', 'routes');
				if (!allRoutesCsrFalse(routesDir)) return; // Kit will build the client itself
				ranStandalone = true;
				const clientDir = path.join(root, '.svelte-kit', 'output', 'client');
				await runStandaloneClientBuild({
					root,
					base,
					clientDir,
					sourcemap,
					makePlugin: (opts) => ogygia({ ...options, ...opts })
				});
			}
		},

		async resolveId(source, importer, options) {
			if (source === V_RUNTIME_URL) return RESOLVED(V_RUNTIME_URL);
			if (source === V_MANIFEST) return RESOLVED(V_MANIFEST);
			if (source === V_RUNTIME) return RESOLVED(V_RUNTIME);
			if (source === V_SECRET) return RESOLVED(V_SECRET);
			if (source === V_SERVER_MANIFEST) return RESOLVED(V_SERVER_MANIFEST);

			const isSsr = options?.ssr ?? isSSR;

			// CLIENT build: swap Kit's client remote runtime for ours (Kit's needs `app`,
			// which never boots under csr=false). enforce:'pre' wins over Kit's resolveId.
			if (!isSsr && source === '__sveltekit/remote') return REMOTE_CLIENT;

			// imports originating directly inside an island virtual module or a bundled
			// script. `$app/*` is aliased to client shims at load-time (client build only).
			if (importer && (registry.has(importer) || scriptRegistry.has(importer))) {
				const host = (registry.get(importer) || scriptRegistry.get(importer)).hostPath;
				return this.resolve(source, host, { skipSelf: true });
			}

			// island virtual .svelte modules / bundled script modules: real abs path
			// (static import from host / emitFile id), dev root-relative URL, or /@fs/<abs>.
			if (isIslandPath(source) || isScriptPath(source)) {
				let candidate = source.split('?')[0];
				if (candidate.startsWith('/@fs/')) candidate = candidate.slice('/@fs'.length);
				if (registry.has(candidate) || scriptRegistry.has(candidate)) return candidate;
				const abs = path.join(root, candidate.replace(/^\//, ''));
				if (registry.has(abs) || scriptRegistry.has(abs)) return abs;
			}
			return null;
		},

		load(id, options) {
			if (id === RESOLVED(V_RUNTIME_URL)) {
				const url = isDev ? '/@id/__x00__' + V_RUNTIME : RUNTIME_URL_BUILD;
				return `export default ${JSON.stringify(url)};`;
			}
			if (id === RESOLVED(V_RUNTIME)) {
				return `import 'ogygia/runtime';`;
			}
			if (id === RESOLVED(V_SECRET)) {
				// SERVER only: the real key. CLIENT build: empty string, so the key can never
				// leak into a client chunk (server islands are a csr=false feature anyway).
				const ssr = options?.ssr ?? isSSR;
				if (!ssr) return `export const secret = '';`;
				return `export const secret = process.env.OGYGIA_SECRET || ${JSON.stringify(buildSecret)};`;
			}
			if (id === RESOLVED(V_SERVER_MANIFEST)) {
				// Map of SERVER-island id -> dynamic import, used by the `ogygiaHandle()` handle to
				// render an island server-side. Populated in BOTH dev and build (unlike the
				// client manifest, which dev fills from URLs). Client build gets an empty map.
				const ssr = options?.ssr ?? isSSR;
				if (!ssr) return `export const islands = {};`;
				prescan();
				const entries = [];
				for (const [iid, virtualPath] of byId) {
					if (!registry.get(virtualPath)?.server) continue;
					entries.push(`  ${JSON.stringify(iid)}: () => import(${JSON.stringify(virtualPath)})`);
				}
				return `export const islands = {\n${entries.join(',\n')}\n};`;
			}
			if (id === RESOLVED(V_MANIFEST)) {
				if (isDev) {
					return `export const dev = true;\nexport const spa = ${spa};\nexport const islands = {};`;
				}
				prescan();
				const entries = [];
				for (const [iid, virtualPath] of byId) {
					// server islands never ship to the client — keep them out of the client manifest
					if (registry.get(virtualPath)?.server) continue;
					entries.push(`  ${JSON.stringify(iid)}: () => import(${JSON.stringify(virtualPath)})`);
				}
				return `export const dev = false;\nexport const spa = ${spa};\nexport const islands = {\n${entries.join(',\n')}\n};`;
			}
			const srcEntry = registry.get(id) || scriptRegistry.get(id);
			if (srcEntry) {
				let src = srcEntry.source;
				// CLIENT build: rewrite Kit `$app/*` imports to client shims. Kit resolves
				// `$app/*` via a vite alias (before our resolveId), so we can't intercept
				// them in resolveId — but we generate this source, so we rewrite it here.
				// SSR keeps the real Kit modules (correct server-rendered page.data).
				const ssr = options?.ssr ?? isSSR;
				if (!ssr) {
					src = src.replace(
						/(['"])\$app\/(state|stores|navigation)\1/g,
						(_m, _q, name) => JSON.stringify(APP_SHIMS['$app/' + name])
					);
				}
				return src;
			}
			return null;
		},

		transform(code, id) {
			if (!id.endsWith('.svelte')) return null;
			if (id.includes('/node_modules/')) return null;
			if (isIslandPath(id)) return null; // don't re-hoist inside island modules
			const result = runTransform(code, id);
			if (!result) return null;
			register(result);
			return { code: result.code, map: result.map };
		}
	};
}
