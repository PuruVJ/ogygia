import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformHost, ISLAND_DIR } from './transform.js';
import { allRoutesCsrFalse, runStandaloneClientBuild } from './standalone.js';
import { Plugin } from 'vite';

const RUNTIME_ENTRY = fileURLToPath(new URL('../runtime/index.js', import.meta.url));

// Client-side shims aliased for island modules (Kit's client runtime is absent under csr=false).
const APP_SHIMS = {
	'$app/state': fileURLToPath(new URL('../shims/app-state.svelte.js', import.meta.url)),
	'$app/stores': fileURLToPath(new URL('../shims/app-stores.js', import.meta.url)),
	'$app/navigation': fileURLToPath(new URL('../shims/app-navigation.js', import.meta.url))
};

// A lake's component code must ship in NO client chunk. In the CLIENT build of an island's virtual
// module we swap every lake import for this render-nothing placeholder (the runtime lifts/restores
// the lake's SSR DOM around hydration). SSR keeps the real component.
const LAKE_PLACEHOLDER = fileURLToPath(new URL('../LakePlaceholder.svelte', import.meta.url));

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

// Content-hash the runtime's real inputs (the prebuilt dist files the runtime chunk bundles).
// Kit builds the SERVER bundle BEFORE the client, so a forward handoff of the client chunk's hash
// is impossible — but a SOURCE-content hash is deterministic, so both builds compute the SAME
// filename independently and agree. (Standalone mode still overrides this with the real output
// chunk hash; this is its fallback + the Kit-driven answer.)
function runtime_content_hash() {
	const inputs = [
		RUNTIME_ENTRY,
		fileURLToPath(new URL('../runtime/router.js', import.meta.url)),
		fileURLToPath(new URL('../shims/page-store.svelte.js', import.meta.url)),
		fileURLToPath(new URL('../shims/kit-remote/client-stub.js', import.meta.url)),
		fileURLToPath(new URL('../NestedProvider.svelte', import.meta.url))
	];
	const h = crypto.createHash('sha256');
	for (const f of inputs) {
		try {
			h.update(fs.readFileSync(f));
		} catch {
			/* a missing input just doesn't contribute — still deterministic across both builds */
		}
	}
	return h.digest('hex').slice(0, 12);
}
const RUNTIME_HASH = runtime_content_hash();
const RUNTIME_FILENAME = `_app/immutable/ogygia-runtime.${RUNTIME_HASH}.js`;
const RUNTIME_URL_BUILD = '/' + RUNTIME_FILENAME;

function to_posix(p) {
	return p.split(path.sep).join('/');
}

function is_island_path(id) {
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
		lake_restore?: 'cache' | 'empty';
	} = {}
): Plugin {
	const spa = options.spa !== false;
	const standalone = options.standalone === true;
	const visibleMargin = options.visible?.margin;
	const presets = options.presets || {};
	// Lake DOM restore policy for `{#if}`-toggle re-creation: 'cache' re-inserts the frozen SSR DOM
	// when the region is re-created; 'empty' leaves it empty. Default 'cache'. NOTE: the option key
	// is deliberately flat snake_case (`lake_restore`) by explicit user decision — a documented
	// exception to the public-API-camelCase convention (see CONTRIBUTING.md).
	const lake_restore = options.lake_restore === 'empty' ? 'empty' : 'cache';

	// HMAC key for signing server-island props. Runtime env var wins (so it can be rotated
	// / shared across instances in production); otherwise a per-build random key baked into
	// the SERVER bundle only (never a client chunk — see the `virtual:ogygia/secret` load).
	const build_secret = crypto.randomBytes(32).toString('hex');

	/** @type {Map<string, {source:string, hostPath:string, id:string}>} keyed by abs virtual path */
	const registry = new Map();
	/** Absolute module ids in an island's CLIENT dependency graph. `$app/*` resolves to shims
	 *  for these importers (virtual island module AND its transitive component imports). */
	const island_graph = new Set();
	const strip_id = (id) => (id ? id.split('?')[0] : id);
	/** @type {Map<string, string>} iid -> abs virtual path (hydrate + defer islands only) */
	const by_id = new Map();
	/** @type {Map<string, 'hydrate'|'defer'|'lake'>} every region id -> kind (drives the client `regions` manifest) */
	const region_kinds = new Map();

	let root;
	let base = '';
	let libDir;
	let is_dev = false;
	let is_build = false;
	let is_ssr = false;
	let scanned = false;
	let sourcemap = false;
	let ran_standalone = false;
	/** absolute path to Kit's internal wire-protocol module (deep import) */
	let kit_wire_path = null;
	/** absolute path to Kit's client remote-functions entry (Plan A reuse) */
	let kit_remote_index = null;
	/** absolute path to the app's universal hooks (for `transport`), if present */
	let universal_hooks = null;
	/** the content-hashed runtime URL, once known (standalone build only; same plugin instance) */
	let hashed_runtime_url = null;

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
		const rel = to_posix(path.relative(root, virtualPath));
		const prefix = base && base !== '/' ? base.replace(/\/$/, '') : '';
		return prefix + '/' + rel;
	};

	const run_transform = (source, id) => {
		return transformHost(source, id, {
			root,
			libDir,
			readFile,
			pathModule: path,
			dev: is_dev,
			virtualPathFor,
			devUrlFor,
			visibleMargin,
			presets
		});
	};

	const register = (result) => {
		for (const isl of result.islands ?? []) {
			region_kinds.set(isl.id, isl.kind ?? (isl.server ? 'defer' : 'hydrate'));
			// Lake entries are metadata-only (no virtual module) — they never get a client module.
			if (!isl.virtualPath) continue;
			registry.set(isl.virtualPath, {
				source: isl.source,
				hostPath: isl.hostPath,
				id: isl.id,
				server: !!isl.server,
				lakes: isl.lakes ?? []
			});
			by_id.set(isl.id, isl.virtualPath);
			island_graph.add(isl.virtualPath);
			if (isl.componentPath) island_graph.add(isl.componentPath);
		}
	};

	/** Pre-scan every app .svelte so the build manifest is complete before it loads. */
	const prescan = () => {
		if (scanned) return;
		scanned = true;
		const src_dir = path.join(root, 'src');
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
					const result = run_transform(src, full);
					if (result) register(result);
				}
			}
		};
		walk(src_dir);
	};

	return {
		name: 'ogygia',
		enforce: 'pre',

		configResolved(config) {
			root = config.root;
			base = config.base || '';
			libDir = path.join(root, 'src', 'lib');
			is_dev = config.command === 'serve';
			is_build = config.command === 'build';
			is_ssr = !!config.build?.ssr;
			sourcemap = !!config.build?.sourcemap;

			// Locate Kit's internal wire-protocol module by resolving its package.json (that IS
			// exported) and joining the src path — deep-importing the file bypasses the exports map.
			try {
				const require = createRequire(path.join(root, 'noop.js'));
				const kitRoot = path.dirname(require.resolve('@sveltejs/kit/package.json'));
				const candidate = path.join(kitRoot, 'src', 'runtime', 'shared.js');
				if (fs.existsSync(candidate)) kit_wire_path = candidate;
				const remoteIdx = path.join(kitRoot, 'src', 'runtime', 'client', 'remote-functions', 'index.js');
				if (fs.existsSync(remoteIdx)) kit_remote_index = remoteIdx;
			} catch {
				kit_wire_path = null; // fall back to the built-in devalue codec (no transport)
			}
			// the app's universal hooks (default src/hooks.{ts,js}) for `transport`
			for (const f of ['hooks.ts', 'hooks.js']) {
				const abs = path.join(root, 'src', f);
				if (fs.existsSync(abs)) {
					universal_hooks = abs;
					break;
				}
			}
		},

		async buildStart() {
			// CLIENT build (Kit-driven): emit the runtime chunk. Kit builds the SERVER bundle FIRST,
			// then the client, so the server can't learn a hash the LATER client build produces — a
			// forward handoff is impossible. Instead the filename is a deterministic SOURCE-content
			// hash (RUNTIME_FILENAME, computed at module load from the prebuilt dist inputs), so the
			// server (baking the `<script src>`) and the client (emitting this chunk) compute the
			// SAME name independently and agree. (Standalone mode further overrides with the real
			// output-chunk hash below.)
			if (is_build && !is_ssr) {
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
			if (is_build && is_ssr && !standalone && !ran_standalone) {
				const routes_dir = path.join(root, 'src', 'routes');
				if (allRoutesCsrFalse(routes_dir)) {
					ran_standalone = true;
					const clientDir = path.join(root, '.svelte-kit', 'output', 'client');
					const { runtimeFileName } = await runStandaloneClientBuild({
						root,
						base,
						clientDir,
						sourcemap,
						makePlugin: (opts) => ogygia({ ...options, ...opts })
					});
					if (runtimeFileName) hashed_runtime_url = '/' + runtimeFileName;
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
			if (source === V_KIT_WIRE && kit_wire_path) return kit_wire_path;
			if (source === V_TRANSPORT) return RESOLVED(V_TRANSPORT);

			const ssr = options?.ssr ?? is_ssr;

			// CLIENT build: Kit's client remote runtime needs `app` (never boots under csr=false).
			// Plan A: reuse Kit's OWN remote primitives, redirecting `__sveltekit/remote` at Kit's
			// real remote-functions entry; the router-coupled modules they import are stubbed just
			// below. Fallback: our hand-rolled shim. enforce:'pre' wins over Kit's resolveId.
			if (!ssr && source === '__sveltekit/remote') {
				if (!kit_remote_index) {
					throw new Error(
						'[ogygia] could not locate Kit\'s client remote-functions (src). Pin @sveltejs/kit with its `src/` published (2.70.x).'
					);
				}
				return kit_remote_index;
			}
			// Scope-alias the two router-coupled modules Kit's remote-functions pull in, ONLY when
			// imported from within Kit's remote-functions dir (so a csr=true page's real Kit client
			// still gets the real client.js). Keeps the router graph out of island bundles.
			if (!ssr && importer && importer.includes('/remote-functions/')) {
				if (/(^|\/)client\.js$/.test(source)) return STUB_CLIENT;
				if (/state\.svelte\.js$/.test(source)) return STUB_STATE;
			}
			if (!ssr && source === '$app/paths/internal/client') return STUB_PATHS;

			// Island CLIENT graph: shim `$app/*` for the virtual module AND every module it
			// pulls in (e.g. `$lib/PageUrlProbe.svelte` importing `$app/state`). Kit's alias
			// would otherwise give islands the uninitialized Kit page (`new URL('a:')` → empty
			// pathname). enforce:'pre' wins over Kit's resolveId. SSR keeps real Kit modules.
			const importer_id = strip_id(importer);
			const from_island =
				importer_id && (registry.has(importer_id) || island_graph.has(importer_id));
			if (!ssr && from_island && APP_SHIMS[source]) {
				return APP_SHIMS[source];
			}
			// Virtual island module: resolve relative to the host file, and mark the resolved
			// id so its own `$app/*` imports hit the shim branch above.
			if (importer_id && registry.has(importer_id)) {
				const host = registry.get(importer_id).hostPath;
				const resolved = await this.resolve(source, host, { skipSelf: true });
				if (resolved?.id) island_graph.add(strip_id(resolved.id));
				return resolved;
			}
			// Transitive island-graph module (not a virtual entry): mark deps so nested
			// `$app/*` imports stay shimmed. Do NOT resolve island virtual paths via skipSelf
			// (that would bypass the is_island_path handling below) — only mark+forward
			// ordinary imports.
			if (!ssr && importer_id && island_graph.has(importer_id) && !is_island_path(source)) {
				const resolved = await this.resolve(source, importer, { skipSelf: true });
				if (resolved?.id) island_graph.add(strip_id(resolved.id));
				return resolved;
			}

			// island virtual .svelte modules: real abs path (static import from host / emitFile
			// id), dev root-relative URL, or /@fs/<abs>.
			if (is_island_path(source)) {
				let candidate = source.split('?')[0];
				if (candidate.startsWith('/@fs/')) candidate = candidate.slice('/@fs'.length);
				if (registry.has(candidate)) {
					island_graph.add(candidate);
					return candidate;
				}
				const abs = path.join(root, candidate.replace(/^\//, ''));
				if (registry.has(abs)) {
					island_graph.add(abs);
					return abs;
				}
			}
			return null;
		},

		load(id, options) {
			if (id === RESOLVED(V_RUNTIME_URL)) {
				// dev: the vite dev URL. build: the CONTENT-HASHED runtime URL — from this
				// instance (standalone) or the handoff file the client build wrote (Kit-driven);
				// fall back to the fixed name only if the handoff is somehow missing.
				const url = is_dev ? '/@id/__x00__' + V_RUNTIME : hashed_runtime_url || RUNTIME_URL_BUILD;
				return `export default ${JSON.stringify(url)};`;
			}
			if (id === RESOLVED(V_RUNTIME)) {
				return `import 'ogygia/runtime';`;
			}
			if (id === RESOLVED(V_TRANSPORT)) {
				// re-export the app's universal `transport` hook (or an empty map) for the client
				// remote wire codec. Universal hooks are isomorphic, so this is client-safe.
				if (universal_hooks) {
					const spec = JSON.stringify(universal_hooks);
					return `import * as hooks from ${spec};\nexport const transport = hooks.transport || {};`;
				}
				return `export const transport = {};`;
			}
			if (id === RESOLVED(V_SECRET)) {
				// SERVER only: the real key. CLIENT build: empty string, so the key can never
				// leak into a client chunk (server islands are a csr=false feature anyway).
				const ssr = options?.ssr ?? is_ssr;
				if (!ssr) return `export const secret = '';`;
				return `export const secret = process.env.OGYGIA_SECRET || ${JSON.stringify(build_secret)};`;
			}
			if (id === RESOLVED(V_SERVER_MANIFEST)) {
				// Map of SERVER-island id -> dynamic import, used by the `ogygiaHandle()` handle to
				// render an island server-side. Populated in BOTH dev and build (unlike the
				// client manifest, which dev fills from URLs). Client build gets an empty map.
				const ssr = options?.ssr ?? is_ssr;
				if (!ssr) return `export const islands = {};`;
				prescan();
				const entries = [];
				for (const [iid, virtualPath] of by_id) {
					if (!registry.get(virtualPath)?.server) continue;
					entries.push(`  ${JSON.stringify(iid)}: () => import(${JSON.stringify(virtualPath)})`);
				}
				return `export const islands = {\n${entries.join(',\n')}\n};`;
			}
			if (id === RESOLVED(V_MANIFEST)) {
				if (is_dev) {
					return `export const dev = true;\nexport const spa = ${spa};\nexport const lake_restore = ${JSON.stringify(lake_restore)};\nexport const regions = {};`;
				}
				prescan();
				// One `regions` record for ALL region kinds. ONLY kind:'hydrate' carries a `load`
				// thunk — lake + defer entries are metadata-only, so a lake's (or server island's)
				// component JS is never pulled into the client graph (the lakes suite guards this).
				const entries = [];
				for (const [rid, kind] of region_kinds) {
					if (kind === 'hydrate') {
						const virtualPath = by_id.get(rid);
						entries.push(
							`  ${JSON.stringify(rid)}: { kind: 'hydrate', load: () => import(${JSON.stringify(virtualPath)}) }`
						);
					} else {
						entries.push(`  ${JSON.stringify(rid)}: { kind: ${JSON.stringify(kind)} }`);
					}
				}
				return `export const dev = false;\nexport const spa = ${spa};\nexport const lake_restore = ${JSON.stringify(lake_restore)};\nexport const regions = {\n${entries.join(',\n')}\n};`;
			}
			const srcEntry = registry.get(id);
			if (srcEntry) {
				let src = srcEntry.source;
				// CLIENT build: rewrite `$app/*` in the GENERATED virtual source to absolute
				// shim paths (defense in depth alongside resolveId island-graph shimming).
				// SSR keeps the real Kit modules (correct server-rendered page.data).
				const ssr = options?.ssr ?? is_ssr;
				if (!ssr) {
					src = src.replace(
						/(['"])\$app\/(state|stores|navigation)\1/g,
						(_m, _q, name) => JSON.stringify(APP_SHIMS['$app/' + name])
					);
					// LAKES: swap each lake import for the render-nothing placeholder so the lake
					// component's JS is excluded from this island's client chunk. Match `import <Local>`
					// (default import — a component) and repoint its specifier at the placeholder.
					for (const local of srcEntry.lakes ?? []) {
						const re = new RegExp(
							`(import\\s+${local}\\s+from\\s+)(['"])[^'"]+\\2`,
							'g'
						);
						src = src.replace(re, (_m, head) => head + JSON.stringify(LAKE_PLACEHOLDER));
					}
				}
				return src;
			}
			return null;
		},

		transform(code, id, options) {
			const ssr = options?.ssr ?? is_ssr;
			// Discover islands before any module is transformed so island_graph is populated
			// even when an island entry component is processed before its host page.
			if (!scanned) prescan();

			const id_n = strip_id(id);
			let out = code;
			let map = null;
			let touched = false;

			if (
				id_n.endsWith('.svelte') &&
				!id_n.includes('/node_modules/') &&
				!is_island_path(id_n)
			) {
				const result = run_transform(code, id_n);
				if (result) {
					register(result);
					out = result.code;
					map = result.map;
					touched = true;
				}
			}

			// CLIENT: rewrite `$app/(state|stores|navigation)` inside island entry components
			// (and any other island_graph .svelte) to absolute shim paths. Absolute paths bypass
			// Kit's `$app/*` alias entirely — needed because Kit's client build still emits
			// csr=false page nodes that import island components directly as `__component`.
			if (!ssr && island_graph.has(id_n) && id_n.endsWith('.svelte')) {
				const rewritten = out.replace(
					/(['"])\$app\/(state|stores|navigation)\1/g,
					(_m, _q, name) => JSON.stringify(APP_SHIMS['$app/' + name])
				);
				if (rewritten !== out) {
					out = rewritten;
					map = null; // import path rewrite invalidates a prior sourcemap
					touched = true;
				}
			}

			return touched ? { code: out, map } : null;
		}
	};
}
