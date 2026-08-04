import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
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

// Reuse Kit's OWN client remote primitives (query/command/form/live). We point
// `__sveltekit/remote` at Kit's real remote-functions and scope-alias the two router-coupled
// modules those pull in (`client.js`, `state.svelte.js`) to tiny stubs, so the router graph
// never loads. The old hand-rolled wire client is gone; these stubs are the only glue.
const STUB_CLIENT = fileURLToPath(new URL('../shims/kit-remote/client-stub.js', import.meta.url));
const STUB_STATE = fileURLToPath(new URL('../shims/kit-remote/state-stub.js', import.meta.url));
const STUB_PATHS = fileURLToPath(new URL('../shims/kit-remote/paths-internal-stub.js', import.meta.url));

const V_RUNTIME_URL = 'virtual:ogygia/runtime-url';
const V_MANIFEST = 'virtual:ogygia/manifest';
const V_RUNTIME = 'virtual:ogygia-runtime';
const V_SECRET = 'virtual:ogygia/secret';
const V_SERVER_MANIFEST = 'virtual:ogygia/server-manifest';
// Reuse Kit's OWN wire protocol (transport-aware devalue arg/response codec) instead of
// reimplementing it. We deep-import Kit's internal `runtime/shared.js` by absolute path
// (bypassing the exports map) and feed it the app's universal `transport` hook.
const V_KIT_WIRE = 'virtual:ogygia/kit-wire';
const V_TRANSPORT = 'virtual:ogygia/transport';
const RESOLVED = (id) => '\0' + id;

const RUNTIME_FILENAME = '_app/immutable/ogygia-runtime.js';
const RUNTIME_URL_BUILD = '/' + RUNTIME_FILENAME;

function toPosix(p) {
	return p.split(path.sep).join('/');
}

function isIslandPath(id) {
	return id.includes('/' + ISLAND_DIR + '/') && id.endsWith('.svelte');
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.spa=true] enable the built-in SPA router
 * @param {{margin?:string}} [options.visible] global defaults for `hydrate: 'visible'` islands
 * @param {Record<string, {hydrate?:string, defer?:string, margin?:string}>} [options.presets]
 *   named strategy presets referenced from imports via `with { preset: 'name' }`
 * @param {boolean} [options.standalone] internal: this instance runs inside the standalone build
 * @returns {import('vite').Plugin}
 */
export function ogygia(
	options: {
		spa?: boolean;
		standalone?: boolean;
		visible?: { margin?: string };
		presets?: Record<string, { hydrate?: string; defer?: string; margin?: string }>;
	} = {}
) {
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

	let root;
	let base = '';
	let libDir;
	let isDev = false;
	let isBuild = false;
	let isSSR = false;
	let scanned = false;
	let sourcemap = false;
	let ranStandalone = false;
	/** absolute path to Kit's internal wire-protocol module (deep import) */
	let kitWirePath = null;
	/** absolute path to Kit's client remote-functions entry (Plan A reuse) */
	let kitRemoteIndex = null;
	/** absolute path to the app's universal hooks (for `transport`), if present */
	let universalHooks = null;
	/** the content-hashed runtime URL, once known (standalone build only; same plugin instance) */
	let hashedRuntimeUrl = null;

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

	const runTransform = (source, id) => {
		return transformHost(source, id, {
			root,
			libDir,
			readFile,
			pathModule: path,
			dev: isDev,
			virtualPathFor,
			devUrlFor,
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

			// Locate Kit's internal wire-protocol module by resolving its package.json (that IS
			// exported) and joining the src path — deep-importing the file bypasses the exports map.
			try {
				const require = createRequire(path.join(root, 'noop.js'));
				const kitRoot = path.dirname(require.resolve('@sveltejs/kit/package.json'));
				const candidate = path.join(kitRoot, 'src', 'runtime', 'shared.js');
				if (fs.existsSync(candidate)) kitWirePath = candidate;
				const remoteIdx = path.join(kitRoot, 'src', 'runtime', 'client', 'remote-functions', 'index.js');
				if (fs.existsSync(remoteIdx)) kitRemoteIndex = remoteIdx;
			} catch {
				kitWirePath = null; // fall back to the built-in devalue codec (no transport)
			}
			// the app's universal hooks (default src/hooks.{ts,js}) for `transport`
			for (const f of ['hooks.ts', 'hooks.js']) {
				const abs = path.join(root, 'src', f);
				if (fs.existsSync(abs)) {
					universalHooks = abs;
					break;
				}
			}
		},

		async buildStart() {
			// CLIENT build (Kit-driven): emit the runtime chunk. NOTE: Kit builds the SERVER
			// bundle FIRST, then the client (kit vite index: "first, build server nodes …", then
			// "create client build"). The server inlines the runtime `<script src>` at server-build
			// time, so it cannot learn a hash the later client build would produce — hence a fixed,
			// stable filename here. (Content-hashing is applied in the STANDALONE mode below, where
			// a single build owns both sides.) See TODO.md.
			if (isBuild && !isSSR) {
				prescan();
				if (!standalone) {
					this.emitFile({ type: 'chunk', id: RUNTIME_ENTRY, fileName: RUNTIME_FILENAME });
				}
			}

			// SSR build with Kit SKIPPING its client build (every route csr=false): run our own
			// standalone client build NOW — at the START of the server build, before any server
			// chunk emits. Island discovery is prescan-based (needs no server output), so the
			// CONTENT-HASHED runtime filename is known in time to be inlined into the SSR'd runtime
			// `<script src>` (via the virtual runtime-url module — same plugin instance).
			if (isBuild && isSSR && !standalone && !ranStandalone) {
				const routesDir = path.join(root, 'src', 'routes');
				if (allRoutesCsrFalse(routesDir)) {
					ranStandalone = true;
					const clientDir = path.join(root, '.svelte-kit', 'output', 'client');
					const { runtimeFileName } = await runStandaloneClientBuild({
						root,
						base,
						clientDir,
						sourcemap,
						makePlugin: (opts) => ogygia({ ...options, ...opts })
					});
					if (runtimeFileName) hashedRuntimeUrl = '/' + runtimeFileName;
				}
			}
		},

		async resolveId(source, importer, options) {
			if (source === V_RUNTIME_URL) return RESOLVED(V_RUNTIME_URL);
			if (source === V_MANIFEST) return RESOLVED(V_MANIFEST);
			if (source === V_RUNTIME) return RESOLVED(V_RUNTIME);
			if (source === V_SECRET) return RESOLVED(V_SECRET);
			if (source === V_SERVER_MANIFEST) return RESOLVED(V_SERVER_MANIFEST);
			// deep-import Kit's own wire helpers by absolute path (bypasses the exports map)
			if (source === V_KIT_WIRE && kitWirePath) return kitWirePath;
			if (source === V_TRANSPORT) return RESOLVED(V_TRANSPORT);

			const isSsr = options?.ssr ?? isSSR;

			// CLIENT build: Kit's client remote runtime needs `app` (never boots under csr=false).
			// Plan A: reuse Kit's OWN remote primitives, redirecting `__sveltekit/remote` at Kit's
			// real remote-functions entry; the router-coupled modules they import are stubbed just
			// below. Fallback: our hand-rolled shim. enforce:'pre' wins over Kit's resolveId.
			if (!isSsr && source === '__sveltekit/remote') {
				if (!kitRemoteIndex) {
					throw new Error(
						'[ogygia] could not locate Kit\'s client remote-functions (src). Pin @sveltejs/kit with its `src/` published (2.70.x).'
					);
				}
				return kitRemoteIndex;
			}
			// Scope-alias the two router-coupled modules Kit's remote-functions pull in, ONLY when
			// imported from within Kit's remote-functions dir (so a csr=true page's real Kit client
			// still gets the real client.js). Keeps the router graph out of island bundles.
			if (!isSsr && importer && importer.includes('/remote-functions/')) {
				if (/(^|\/)client\.js$/.test(source)) return STUB_CLIENT;
				if (/state\.svelte\.js$/.test(source)) return STUB_STATE;
			}
			if (!isSsr && source === '$app/paths/internal/client') return STUB_PATHS;

			// imports originating directly inside an island virtual module. `$app/*` is aliased
			// to client shims at load-time (client build only).
			if (importer && registry.has(importer)) {
				const host = registry.get(importer).hostPath;
				return this.resolve(source, host, { skipSelf: true });
			}

			// island virtual .svelte modules: real abs path (static import from host / emitFile
			// id), dev root-relative URL, or /@fs/<abs>.
			if (isIslandPath(source)) {
				let candidate = source.split('?')[0];
				if (candidate.startsWith('/@fs/')) candidate = candidate.slice('/@fs'.length);
				if (registry.has(candidate)) return candidate;
				const abs = path.join(root, candidate.replace(/^\//, ''));
				if (registry.has(abs)) return abs;
			}
			return null;
		},

		load(id, options) {
			if (id === RESOLVED(V_RUNTIME_URL)) {
				// dev: the vite dev URL. build: the CONTENT-HASHED runtime URL — from this
				// instance (standalone) or the handoff file the client build wrote (Kit-driven);
				// fall back to the fixed name only if the handoff is somehow missing.
				const url = isDev ? '/@id/__x00__' + V_RUNTIME : hashedRuntimeUrl || RUNTIME_URL_BUILD;
				return `export default ${JSON.stringify(url)};`;
			}
			if (id === RESOLVED(V_RUNTIME)) {
				return `import 'ogygia/runtime';`;
			}
			if (id === RESOLVED(V_TRANSPORT)) {
				// re-export the app's universal `transport` hook (or an empty map) for the client
				// remote wire codec. Universal hooks are isomorphic, so this is client-safe.
				if (universalHooks) {
					const spec = JSON.stringify(universalHooks);
					return `import * as hooks from ${spec};\nexport const transport = hooks.transport || {};`;
				}
				return `export const transport = {};`;
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
			const srcEntry = registry.get(id);
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
