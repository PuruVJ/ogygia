import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { loadEnv, type Plugin } from 'vite';
import type { PreprocessorGroup } from 'svelte/compiler';
import { configure_build_cache } from '../build-cache.js';
import { islandBridge, content_css_key } from './island-bridge.js';
import { island_sourcemaps_plugin } from './sourcemaps.js';
import { materialize } from '../compiler/content/git.js';
import { rewrite_loaders } from '../compiler/content/loaders.js';
import { rewrite_regions } from '../compiler/content/regions.js';
import { content as contentHmrPlugin, type ContentPluginOptions } from '../content/vite/plugin.js';
import { ogygiaPresetPreprocess } from '../content/markdown/index.js';
import {
	is_island_path,
	normalize_import_keys,
	islandChunkFileName,
	type ImportKeys
} from '../compiler/region/transform.js';

export {
	normalize_import_keys,
	DEFAULT_IMPORT_KEYS,
	import_keys_hint,
	islandChunkFileName,
	islandPublicUrl,
	islandId,
	wrapperVirtualId,
	CLIENT_BINDING_STUB,
	regionId,
	regionIdentity,
	strategyKey
} from '../compiler/region/transform.js';
export { rewrite_lake_import_to_placeholder } from '../compiler/region/emit.js';
import { APP_SHIM_IMPORT } from '../compiler/region/emit.js';
export type { ImportKeys } from '../compiler/region/transform.js';
export type {
	OgygiaPreset,
	OgygiaRateLimit,
	RegionsOptions,
	ContentPreset,
	OgygiaOptions
} from './options.js';
import {
	assert_no_legacy_options,
	validate_region_presets,
	validate_content_presets
} from './options.js';
import {
	clientBuildWillSkip,
	hasAnyCsrFalseRoute,
	keep_client_dir,
	inject_keep_client_route
} from '../compiler/standalone.js';
import {
	appendTransportRegistrations,
	appendSvelteModuleRegistrations
} from '../compiler/content/transportables.js';
import { DEFAULT_REGION_TTL_SEC } from '../server/endpoint.js';
import {
	derive_id_salt,
	secret_has_min_entropy,
	MIN_SECRET_BYTES
} from '../server/hmac.js';
import {
	buildFoucCssModuleSource,
	compileFoucScopedCss,
	foucRelFromId,
	isFoucCssId,
	isFoucScopedId
} from '../compiler/fouc-css.js';
import {
	needs_csr_false_full_reload,
	needs_island_entry_full_reload,
	same_module_path,
	island_vpaths_affected_by_file
} from '../compiler/dev/hmr.js';
import { derive_css_scope_owners, type DevGraphModule } from '../compiler/dev/css-scope.js';
import { collectIslandDepModulepreloads } from '../compiler/link/island-deps.js';
import { warn_content_leaks, emit_island_deps_handoff } from '../compiler/link/build-output.js';
import { Program, strip_id, host_key } from '../compiler/program.js';
import { Compiler } from '../compiler/driver.js';
import { CompileCtx } from '../compiler/ctx.js';
import {
	V_MANIFEST,
	V_RUNTIME_ENTRY,
	V_SERVER_MANIFEST,
	V_KIT_WIRE,
	RESOLVED
} from '../compiler/ids.js';

/** `packages/ogygia` — Vite must serve absolute shim/runtime resolves from outside the app root. */
const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * ogygia's OWN runtime imports that the transform INJECTS into a host component or a generated
 * wrapper (Region / og_portable, and server-island endpoint minting). They are ours, not something
 * the author wrote, so they must resolve to ogygia's OWN files (see OGYGIA_INJECTED_FILES) — NOT from
 * the importer's package. Otherwise a host that lives in a monorepo sub-package which doesn't itself
 * depend on ogygia can't resolve a bare `ogygia/internal`. (A user's OWN marked package import —
 * `X from 'ogygia/content/…' with { wake }` — is deliberately NOT here: that resolves from the host
 * file, whose package must expose the subpath.)
 */
const OGYGIA_INJECTED_IMPORTS = new Set(['ogygia/internal', 'ogygia/internal/server']);

/**
 * DIRECT paths to ogygia's OWN injected runtime entries, resolved WITHOUT `this.resolve`. The
 * transform writes `ogygia/internal` / `ogygia/internal/server` into a host or a generated island
 * module, and a host in a monorepo sub-package that doesn't depend on ogygia must still resolve them.
 * `this.resolve` off a synthetic importer is NOT portable across bundler versions (returns null in
 * vite@8, can THROW in rolldown-vite@7 — which aborts the whole hook), and `config.root` can be
 * undefined on a throwaway Kit plugin instance — so we address ogygia's own files head-on instead.
 *
 * PKG_ROOT is this package (the plugin runs from `dist/vite/index.js`, so `../..` is the package
 * root). A published install ships only `dist` → `dist/internal.js`. ogygia's OWN source checkout has
 * `src/`, and the rest of the app resolves ogygia through the `svelte` export condition (→ `src`), so
 * there we point at `src/internal.ts` too — same module, no Region/brand identity fork.
 */
const OG_HAS_SRC = fs.existsSync(path.join(PKG_ROOT, 'src/internal.ts'));
const OGYGIA_INJECTED_FILES: Record<string, string> = OG_HAS_SRC
	? {
			'ogygia/internal': path.join(PKG_ROOT, 'src/internal.ts'),
			'ogygia/internal/server': path.join(PKG_ROOT, 'src/internal-server.ts')
		}
	: {
			'ogygia/internal': path.join(PKG_ROOT, 'dist/internal.js'),
			'ogygia/internal/server': path.join(PKG_ROOT, 'dist/internal-server.js')
		};

// Client-side shims aliased for island modules (Kit's client runtime is absent under csr=false).
const APP_SHIMS = {
	'$app/state': fileURLToPath(new URL('../shims/app-state.svelte.js', import.meta.url)),
	'$app/stores': fileURLToPath(new URL('../shims/app-stores.js', import.meta.url)),
	'$app/navigation': fileURLToPath(new URL('../shims/app-navigation.js', import.meta.url))
};

// A lake's component code must ship in NO client chunk. In the CLIENT build of an island's virtual
// module we swap every lake import for a render-nothing stub (the runtime lifts/restores the lake's
// SSR DOM around hydration). SSR keeps the real component. Same empty `ClientBindingStub` used for
// portable bindings — a lake placeholder and a binding stub are both "render nothing on the client".
/** On-disk stub for `virtual:ogygia/client-binding-stub` (csr=false client hosts). */
const CLIENT_BINDING_STUB_FILE = fileURLToPath(
	new URL('../ClientBindingStub.svelte', import.meta.url)
);

// Reuse Kit's OWN client remote primitives (query/command/form/live). We point
// `__sveltekit/remote` at Kit's real remote-functions and scope-alias the two router-coupled
// modules those pull in (`client.js`, `state.svelte.js`) to tiny stubs, so the router graph
// never loads. The old hand-rolled wire client is gone; these stubs are the only glue.
const STUB_CLIENT = fileURLToPath(new URL('../shims/kit-remote/client-stub.js', import.meta.url));
const STUB_STATE = fileURLToPath(new URL('../shims/kit-remote/state-stub.js', import.meta.url));
const STUB_PATHS = fileURLToPath(new URL('../shims/kit-remote/paths-internal-stub.js', import.meta.url));
/** Absolute path to real HMAC (SSR-only via `virtual:ogygia/sign`). */
const HMAC_MODULE = fileURLToPath(new URL('../server/hmac.js', import.meta.url));

const RUNTIME_DIR = fileURLToPath(new URL('../runtime', import.meta.url));

/** Absolute path to SSR region-endpoint helper (signed capability URLs). */
const REGION_ENDPOINT_MODULE = fileURLToPath(new URL('../server/region-endpoint.js', import.meta.url));

// Content-hash the runtime's real inputs (the prebuilt dist files the runtime chunk bundles).
// Kit builds the SERVER bundle BEFORE the client, so a forward handoff of the client chunk's hash
// is impossible — but a SOURCE-content hash is deterministic, so both builds compute the SAME
// filename independently and agree. (Standalone mode still overrides this with the real output
// chunk hash; this is its fallback + the Kit-driven answer.)
function runtime_content_hash() {
	const inputs = [
		fileURLToPath(new URL('../compiler/link/runtime-entry.js', import.meta.url)),
		fileURLToPath(new URL('../live-transport.js', import.meta.url)),
		fileURLToPath(new URL('../shims/page-store.svelte.js', import.meta.url)),
		fileURLToPath(new URL('../shims/kit-remote/client-stub.js', import.meta.url)),
		fileURLToPath(new URL('../NestedProvider.svelte', import.meta.url)),
		fileURLToPath(new URL('../LiveHost.svelte', import.meta.url))
	];
	// Every runtime module (core + feature impls + slots) — any change must bust the sticky filename.
	try {
		const rt_dir = fileURLToPath(new URL('../runtime', import.meta.url));
		for (const name of fs.readdirSync(rt_dir)) {
			if (name.endsWith('.js')) inputs.push(path.join(rt_dir, name));
		}
	} catch {
		/* dist may lack runtime until first build */
	}
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

const KIT_REMOTE_CLIENT = /(^|\/)client\.js$/;
const KIT_REMOTE_STATE = /state\.svelte\.js$/;

/** css-ish file the dev bridge manages (mirrors the bridge's glob). */
const DEV_CSS_FILE_RE = /\.(css|scss|sass|less|styl)$/;

import type {
	OgygiaPreset,
	OgygiaRateLimit,
	RegionsOptions,
	ContentPreset,
	OgygiaOptions
} from './options.js';


/**
 * Vite plugin: transforms `with { hydrate | defer | preset }` imports into islands,
 * serves virtual island modules, and wires signed region endpoints for deferred HTML.
 *
 * Place **before** `sveltekit()` in `vite.config`.
 *
 * @param options - Plugin configuration. See {@link OgygiaOptions}.
 * @returns Vite plugins (`ogygia` pre + island sourcemap fix post). Vite flattens the array.
 */
export function ogygia(options: OgygiaOptions = {}): Plugin[] {
	const standalone = options.standalone === true;

	assert_no_legacy_options(options);

	const visibleMargin = options.regions?.visible?.margin;
	const presets = options.regions?.presets || {};
	validate_region_presets(presets);
	const import_keys = normalize_import_keys(options.importKeys);

	// Cheap content-gate: does a source use an ogygia island hint (`import X from '…' with { wake|… }`)?
	// Lets LIBRARY components in node_modules opt INTO the island transform without taxing every lib
	// `.svelte` — the enabler for an ecosystem of ogygia-hinted component libraries.
	const hint_keys = Object.values(import_keys).filter((v) => typeof v === 'string');
	const island_hint_re = hint_keys.length
		? new RegExp(`\\bwith\\s*\\{[^}]*\\b(?:${hint_keys.join('|')})\\b`)
		: /$^/;
	const has_island_hint = (code) => island_hint_re.test(code);

	// Publish the markdown config so a value-free `markdown()` in the svelte config reads it — all
	// content/markdown config stays here in the one plugin. `standalone` re-invokes this factory for
	// its throwaway client build; don't let that clobber the real config with `null`.
	if (!standalone && options.content?.markdown) {
		islandBridge.markdownConfig = options.content.markdown as Record<string, unknown>;
	}
	// Content presets — validated (closed vocabulary, non-empty, base required) and published for the
	// loader macros (name check at the use site) + the preprocessor (merged config per variant).
	if (!standalone && options.content?.presets) {
		validate_content_presets(options.content.presets, !!options.content?.markdown);
		islandBridge.contentPresets = options.content.presets as typeof islandBridge.contentPresets;
	}

	// Region-endpoint rate limit (baked into SSR only via virtual:ogygia/rate-limit).
	const rate_limit =
		options.rateLimit === false
			? { max: 0, windowMs: 60_000 }
			: {
					max: Math.max(0, options.rateLimit?.max ?? 60),
					windowMs: Math.max(1, options.rateLimit?.windowMs ?? 60_000)
				};

	/** Cookie name sealed into the region MAC, or '' when unbound (default). */
	const session_cookie =
		typeof options.sessionCookie === 'string' && options.sessionCookie.length > 0
			? options.sessionCookie
			: '';

	/** Capability URL TTL (seconds). Clamped to [60, 86400]. */
	const region_ttl = Math.min(
		86400,
		Math.max(60, Math.floor(options.regionTtl ?? DEFAULT_REGION_TTL_SEC))
	);

	// ROUTER config (app-wide, one place). On by default; View Transitions on unless disabled. `false`
	// tree-shakes the whole feature out. Baked into `virtual:ogygia/router-config` for the handle.
	const router_enabled = options.router !== false;
	const router_view_transitions =
		options.router === false
			? false
			: typeof options.router === 'object'
				? options.router.viewTransitions !== false
				: true;

	// CONTINUITY rides the router (it snapshots on SPA navigation): router on + `forms` not disabled.
	// `router: false` takes forms with it — there is no SPA nav to survive.
	const continuity_forms =
		router_enabled && (typeof options.router === 'object' ? options.router.forms !== false : true);

	// SERVER-DELTA NAV is opt-in (a new client↔server protocol). Only when the router is on AND the app
	// explicitly writes `router: { serverDelta: true }`. Off → the client never sends `x-ogygia-known`,
	// so the server always full-renders (safe fallback). Server-delta needs SPA nav, so router-off ⇒ off.
	const server_delta =
		router_enabled && typeof options.router === 'object' && options.router.serverDelta === true;


	// The Program — this plugin instance's cross-file linker / island graph. It owns the descriptor
	// registry + the feature-mark bag (seeded from the two app-wide config flags), and the behavior
	// over them (register / unregister_host / note_runtime_mark). Per-instance, never module-global,
	// so Kit's throwaway plugin instance is a different Program and can't leak into the real build.
	// The adapter binds local aliases to its Maps (same objects) + methods so the hooks read like before.
	const program = new Program({ forms: continuity_forms, router: router_enabled });
	const {
		registry,
		island_graph,
		by_id,
		region_kinds,
		host_index,
		emitted_island_chunks
	} = program;
	const register = program.register.bind(program);
	const unregister_host = program.unregister_host.bind(program);
	// The feature-selected runtime chunk name lives on the driver as `compiler.runtime_chunk_filename()`
	// (RUNTIME_HASH ⊕ program.runtime_feature_hash — see CompileCtx.runtime_chunk_filename); buildStart's
	// emitFile and the runtime-url virtual both read it, so both build legs compute the same immutable name.

	// HMAC key for signing region capability URLs (defer / remount:swr). Default: a fresh
	// per-build random baked into the SERVER bundle only (never a client chunk). Optional
	// `OGYGIA_SECRET` overrides that so rolling deploys / long-lived cached HTML keep verifying.
	// Sign/verify HKDF-derive a MAC key from this material (`ogygia-mac-v1`).
	const build_secret = crypto.randomBytes(32).toString('hex');
	/** Salt for region ids — HKDF from stable env only (never per-build random, or SSR/client
	 *  builds would disagree). Empty when unset (dev + default per-build signing). */
	let id_salt = '';

	/** content_css_key → emitted CSS asset referenceId (client leg). Resolved to hrefs in writeBundle. */
	const content_css_refs = new Map();
	// tag → self-contained factory source from og.$ rewrites (served by the fn-manifest virtual so
	// client bundles can register factories pre-hydration; the payload-source fallback covers bundles
	// that miss it) now lives on the driver as `compiler.dollar_hoists` — the macro leg fills it.

	let root;
	let base = '';
	let libDir;
	let is_dev = false;
	/** Resolved `resolve.alias` entries — passed to bake()'s rolldown eval so `$lib` etc. resolve. */
	let resolve_alias = [];
	let is_build = false;
	let is_ssr = false;
	let content_scanned = false;
	let sourcemap = false;
	/** @type {import('vite').ViteDevServer | null} */
	let vite_server = null;
	/** absolute path to Kit's internal wire-protocol module (deep import) */
	let kit_wire_path = null;
	/** absolute path to Kit's client remote-functions entry (Plan A reuse) */
	let kit_remote_index = null;
	/** absolute path to the app's universal hooks (for `transport`), if present */
	let universal_hooks = null;
	/** the content-hashed runtime URL, once known (standalone build only; same plugin instance) */
	let hashed_runtime_url = null;
	/** true once the process-exit cleanup for the injected keep-client route is registered */
	let keep_client_cleanup_armed = false;

	const readFile = (abs) => {
		try {
			return fs.readFileSync(abs, 'utf-8');
		} catch {
			return null;
		}
	};

	const __prof = { transformMs: 0, transformN: 0, transformHit: 0, prescanMs: 0, bakeMs: 0, bakeN: 0, resolveMs: 0, loadMs: 0 };
	const __P = !!process.env.OGYGIA_PROFILE;
	const __outHash = new Map<string, number>();

	// The driver — the bundler-agnostic compile session (Program + transform cache + profiler). Its
	// CompileCtx is bound in configResolved once the build is resolved (root/dev/id_salt known).
	// `run_transform` is the adapter-facing alias for `compiler.transform` — the file-local front-end
	// (parse ▸ analyze ▸ lower ▸ emit, today fused in transformHost), memoized + content-gated.
	const compiler = new Compiler(program, { prof: __prof, P: __P, outHash: __outHash });
	const run_transform = compiler.transform.bind(compiler);

	// ── keep-client route injection ──────────────────────────────────────────
	// All-csr=false apps make Kit skip its ENTIRE client build, so ogygia's runtime is never emitted
	// and islands 404 at runtime. Fix: during a build, inject a URL-less keepalive layout — a single
	// `csr = true` node with no `+page`, so no servable URL — which flips Kit's `skip_client_build`
	// check and lets Kit's OWN client build run (honoring the user's preprocessors, appDir, etc.). It
	// is removed at process exit, so nothing is left on disk. This is fully de-internalified — it
	// consults NO SvelteKit internal:
	//   • WHO injects: only the main build thread (`isMainThread`). Kit runs its postbuild analyse/
	//     prerender tasks in worker THREADS that re-load the Vite config; there `isMainThread` is
	//     false, so they never re-create the dir. (Public Node API — not Kit's `SVELTEKIT_FORK`.)
	//   • WHEN we clean up: `process.on('exit')`, which fires once the whole build (client build +
	//     workers + prerender, however Kit nests them) has finished. No dependency on Kit's hook
	//     ordering. Worst case (a hard crash) leaves a gitignored dir that self-heals next run.
	/** Register the one-time process-exit cleanup (main thread only). */
	const arm_keep_client_cleanup = (r) => {
		if (keep_client_cleanup_armed) return;
		keep_client_cleanup_armed = true;
		process.on('exit', () => {
			try {
				fs.rmSync(keep_client_dir(r), { recursive: true, force: true });
			} catch {
				/* best-effort; gitignored + self-healed next run */
			}
		});
	};

	// Preprocessor bridge: `.svx` / `.md` islands are rewritten by a preprocessor (composed into
	// `markdown()`) that runs AFTER mdsvex, then handed back to this plugin's registry. Wrapper-always
	// (linkVirtual: true) because a preprocessor output is shared across the ssr/client legs and can't
	// make the csr=false stub split; content files aren't routes, so they'd get wrappers anyway.
	const island_bridge_transform = (source: string, filename: string) => {
		const result = run_transform(source, filename, { ssr: false, linkVirtual: true });
		if (!result || !result.islands?.length) return null;
		register(result, filename);
		return result.code;
	};
	// `islandBridge` is a MODULE singleton, but Kit evaluates the Vite config more than once (a second,
	// throwaway plugin instance for its SSR environment). If the factory body claimed the bridge, the
	// LAST instance created would win — even one whose `configResolved` never runs, leaving `root`
	// undefined and every content-island transform crashing on `path.join(root, …)`. So the bridge is
	// claimed in `configResolved` instead: only an instance Vite actually configures (root set) owns it.
	const claim_island_bridge = () => {
		islandBridge.transform = island_bridge_transform;
	};

	const invalidate_module_id = (server, id) => {
		const mod = server.moduleGraph.getModuleById(id);
		if (mod) server.moduleGraph.invalidateModule(mod);
	};

	const is_registered_host = (file) =>
		host_index.has(host_key(file)) ||
		[...registry.values()].some((e) => same_module_path(e.hostPath, file));

	/**
	 * Drop Vite's cached virtual island modules + our registry rows for `file`.
	 * Call when a *host* changes (import target rename keeps the same island id) or an
	 * *entry component* is deleted — not on ordinary entry-component content edits (soft HMR).
	 */
	const invalidate_islands_for_file = (file, { deleted = false, server = vite_server } = {}) => {
		if (!server) return false;
		const affected = new Set();

		if (is_registered_host(file)) {
			for (const vpath of island_vpaths_affected_by_file(file, registry.entries())) {
				affected.add(vpath);
			}
			const prev = host_index.get(host_key(file));
			if (prev) for (const vpath of prev.vpaths) affected.add(vpath);
			// Host re-registers on next transform; clear so load() can't serve orphans.
			unregister_host(file);
		}

		if (deleted) {
			for (const [vpath, entry] of [...registry.entries()]) {
				if (!same_module_path(entry.componentPath, file)) continue;
				affected.add(vpath);
				registry.delete(vpath);
				island_graph.delete(vpath);
				by_id.delete(entry.id);
				region_kinds.delete(entry.id);
				const idx = host_index.get(host_key(entry.hostPath));
				if (idx) {
					idx.vpaths.delete(vpath);
					idx.ids.delete(entry.id);
				}
			}
		}

		if (affected.size === 0) return false;

		for (const vpath of affected) invalidate_module_id(server, vpath);
		invalidate_module_id(server, RESOLVED(V_SERVER_MANIFEST));
		invalidate_module_id(server, RESOLVED(V_MANIFEST));
		return true;
	};

	/** Files already warned about a non-server `content()` definition (once per file per process). */
	const content_placement_warned = new Set<string>();

	/**
	 * Nudge (never error): a `content()` collection defined OUTSIDE a server-only module. Kit's own
	 * guard makes `.server.ts` / `src/lib/server/` / `.remote.ts` mechanically un-importable from
	 * client code — anywhere else, one innocent import from an island or route component can drag the
	 * whole corpus (megabytes of compiled markdown) into a client bundle, silently.
	 */
	const warn_content_placement = (bare: string, source: string) => {
		if (content_placement_warned.has(bare)) return;
		// APP source only — never library code (a workspace-linked ogygia sits outside node_modules).
		if (!bare.startsWith(path.join(root, 'src') + path.sep)) return;
		const defines_collection = source.includes('ogygia/content') && /\bcontent\s*\(/.test(source);
		const defines_loader = source.includes('import.meta.og.loader.');
		if (!defines_collection && !defines_loader) return;
		const server_only =
			/\.(server|remote)\.(ts|js|mjs)$/.test(bare) || /\/(src\/lib\/server|server)\//.test(bare.slice(root.length));
		if (server_only) return;
		content_placement_warned.add(bare);
		console.warn(
			`[ogygia/content] ${path.relative(root, bare)} defines a collection outside a server-only module. ` +
				`Move it to a \`.server.ts\` file (or \`src/lib/server/\`) and mint remotes for the wire — ` +
				`Kit then guarantees the corpus can never reach a client bundle.`
		);
	};

	return [
		// Content-collection dev HMR (full reload when a `src/content` file changes). Inert when the
		// app doesn't use content collections. Folded in so `ogygia()` is the only plugin to add.
		contentHmrPlugin(options.content),
		{
			name: 'ogygia',
			enforce: 'pre',

			// `order: 'pre'` so it runs before `sveltekit()`'s config hook, which discovers routes
			// (and computes `skip_client_build`). The injected keep-client route must be on disk first.
			config: {
				order: 'pre',
				handler(userConfig, env) {
					// Keep Kit's client build alive on all-csr=false apps: inject a URL-less keepalive
					// route BEFORE Kit reads the routes. Main build thread only; removed at process exit.
					if (env.command === 'build' && !standalone && isMainThread) {
						const r = path.resolve(userConfig.root ?? '.');
						const routes = path.join(r, 'src', 'routes');
						// `clientBuildWillSkip` ignores our own keepalive dir, so it reflects the user's
						// real routes: inject only when Kit really would skip, else sweep any stale dir.
						if (clientBuildWillSkip(routes)) {
							inject_keep_client_route(r);
							arm_keep_client_cleanup(r);
						} else {
							fs.rmSync(keep_client_dir(r), { recursive: true, force: true });
						}
					}

					// Match Kit: SSR-inline `esm-env` so its development/production export conditions
					// resolve per mode (used if anything in our server graph imports it). Do NOT
					// optimizeDeps.exclude it — that breaks Svelte client prebundles that import DEV.
					//
					// SSR-inline OGYGIA ITSELF too. ogygia ships real `.svelte` components (Region,
					// OgygiaBoundary, …) that the app's server build MUST compile — if ogygia is left
					// EXTERNAL, Node loads a raw `.svelte` at server runtime and crashes with
					// `ERR_UNKNOWN_FILE_EXTENSION`. vite-plugin-svelte normally auto-noExternals a svelte
					// library (ogygia carries the `svelte` export condition), but that detection is fragile
					// under some installs (adapter-node output, a pkg.pr.new URL dependency, an app that
					// pins/overrides noExternal), so we force it here — the plugin is always present, so this
					// can't be missed. `server.fs.allow`: kit-remote stubs / runtime resolve to absolute
					// paths under this package; without it Vite 403s them when the app root is docs/ or playground/.
					return {
						ssr: { noExternal: ['esm-env', 'ogygia'] },
						// CONTINUITY config → compile-time constants the client runtime reads (typeof-guarded,
						// so a plain node import of dist/ without these defined falls back to defaults).
						define: {
							__OGYGIA_CONTINUITY_FORMS__: JSON.stringify(continuity_forms),
							__OGYGIA_SERVER_DELTA__: JSON.stringify(server_delta)
						},
						server: {
							fs: {
								allow: [PKG_ROOT]
							}
						},
						// Island emitFile entries re-export shared components; keep facade exports
						// under Vite 8 / Rolldown (build.rolldownOptions — not deprecated rollupOptions).
						build: {
							rolldownOptions: {
								preserveEntrySignatures: 'exports-only'
							}
						}
					};
				}
			},

		configResolved(config) {
			root = config.root;
			base = config.base || '';
			// Normalize resolve.alias (array or object form) to `{ find, replacement }[]` for bake().
			const ra = config.resolve?.alias ?? [];
			resolve_alias = Array.isArray(ra)
				? ra.map((a) => ({ find: a.find, replacement: a.replacement }))
				: Object.entries(ra).map(([find, replacement]) => ({ find, replacement }));
			// The shared build cache (fences, git checkouts, shas) persists under THIS app's
			// node_modules/.ogygia — point it before anything derives.
			configure_build_cache(root);
			libDir = path.join(root, 'src', 'lib');
			// Claim the content-island preprocessor bridge for THIS (configured) instance — root is set.
			claim_island_bridge();
			is_dev = config.command === 'serve';
			is_build = config.command === 'build';
			is_ssr = !!config.build?.ssr;
			sourcemap = !!config.build?.sourcemap;

			// Self-heal a keep-client route left behind by a crashed build (harmless — no URL — but
			// noisy in the routes tree). Dev never injects, so anything here is a stale leftover.
			if (is_dev) fs.rmSync(keep_client_dir(root), { recursive: true, force: true });

			// Optional stable override. Vite only puts `VITE_*` from `.env` onto import.meta.env —
			// load plain `OGYGIA_SECRET` ourselves so `.env` / `.env.local` work without a shell export.
			if (!process.env.OGYGIA_SECRET?.trim()) {
				const env_dir =
					config.envDir === false
						? false
						: config.envDir
							? path.resolve(root, config.envDir)
							: root;
				if (env_dir !== false) {
					const from_file = loadEnv(config.mode, env_dir, '').OGYGIA_SECRET?.trim();
					if (from_file) process.env.OGYGIA_SECRET = from_file;
				}
			}
			const env_secret = process.env.OGYGIA_SECRET?.trim() || '';
			if (env_secret) {
				// Production builds: reject weak user secrets (L-HMAC). Dev may use short keys.
				if (is_build && !secret_has_min_entropy(env_secret)) {
					throw new Error(
						`[ogygia] OGYGIA_SECRET is too short for production builds (need ≥${MIN_SECRET_BYTES} UTF-8 bytes).`
					);
				}
				id_salt = derive_id_salt(env_secret);
			} else {
				id_salt = '';
			}

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

			// Bind the driver's resolved compile context — now that root/base/libDir/dev + id_salt are
			// known. Every run_transform runs after this (buildStart prescan / the transform hook), so
			// the snapshot is complete before the driver is first called.
			compiler.configure(
				new CompileCtx({
					root,
					base,
					libDir,
					is_dev,
					id_salt,
					visibleMargin,
					presets,
					import_keys,
					resolve_alias,
					markdown_config: islandBridge.markdownConfig ?? null,
					pkg_root: PKG_ROOT,
					build_secret,
					rate_limit,
					session_cookie,
					region_ttl,
					router_enabled,
					router_view_transitions,
					runtime_dir: RUNTIME_DIR,
					runtime_hash: RUNTIME_HASH,
					hmac_module: HMAC_MODULE,
					region_endpoint_module: REGION_ENDPOINT_MODULE,
					client_binding_stub_file: CLIENT_BINDING_STUB_FILE,
					app_shims: APP_SHIMS
				})
			);
		},

		async buildStart() {
			// CLIENT build (Kit-driven): emit the runtime chunk. Kit builds the SERVER bundle FIRST,
			// then the client, so the server can't learn a hash the LATER client build produces — a
			// forward handoff is impossible. Instead the filename is a deterministic SOURCE-content
			// hash of ogygia's runtime SOURCE ⊕ the resolved feature set (`runtime_chunk_filename`), so the
			// server (baking the `<script src>`) and the client (emitting this chunk) compute the
			// SAME name independently and agree. (Standalone mode further overrides with the real
			// output-chunk hash below.)
			// Discover islands up front — in BOTH the SSR and client legs. The client build needs them
			// to emit chunks; the SSR build needs them for the server manifest. Kit builds SSR FIRST,
			// so if we only scanned in the client leg the SSR manifest would miss `.svx`/`.md` SERVER
			// islands (defer / deferred regions) and their signed endpoint would 403. `prescan` reads
			// `.svelte`/`.ts`; `islandBridge.scan` (set by a preprocessor package like ogygia/content)
			// contributes islands from markdown, which becomes Svelte only after that preprocessor.
			// Discover content (`.svx`/`.md`) islands up front in DEV too, not only build. A server
			// (`render: deferred`) island in a content file is registered lazily when its page SSRs —
			// but its signed endpoint is a SEPARATE request that imports the server manifest, and if
			// the island hasn't registered yet the manifest lacks its id → 403 (NOT_IN_MANIFEST). That
			// made content deferred holes flaky in dev (they worked only when the page-SSR registration
			// happened to win the race). `islandBridge.scan` walks the markdown corpus and registers
			// every island before the first request, so the manifest is complete when any endpoint is
			// hit. Idempotent via `content_scanned`; a no-op for apps without a content preprocessor.
			if (!content_scanned) {
				content_scanned = true;
				compiler.prescan();
				await islandBridge.scan?.({ root, readFile });
			}

			if (is_build && !is_ssr) {
				// Pure csr=true app (no csr=false route anywhere) → Kit hydrates everything itself, ogygia
				// ships nothing. Skip the runtime chunk entirely; every host's islands were stripped to
				// plain by the csrTrue transform branch, so nothing references it anyway.
				const emit_runtime = !standalone && hasAnyCsrFalseRoute(path.join(root, 'src', 'routes'));
				if (emit_runtime) {
					// Unresolved virtual id — resolveId/load synthesize the feature-selected entry.
					this.emitFile({
						type: 'chunk',
						id: V_RUNTIME_ENTRY,
						fileName: compiler.runtime_chunk_filename()
					});
				}
				// Hydrate islands: one emitFile per deduped region id (path+strategy), deterministic
				// filename so SSR can bake `entry` without a client→server hash handoff. csr=false
				// hosts omit wrapper imports so this emit owns the module (avoids Rolldown thin
				// facades from page-graph sharing). N instances → still one entry URL.
				for (const [rid, kind] of region_kinds) {
					if (kind !== 'hydrate') continue;
					const virtualPath = by_id.get(rid);
					if (!virtualPath) continue;
					if (emitted_island_chunks.has(rid)) continue;
					emitted_island_chunks.add(rid);
					this.emitFile({
						type: 'chunk',
						id: virtualPath,
						fileName: islandChunkFileName(rid)
					});
				}
				// Content CSS: a content module's OWN scoped `<style>` compiles into the SERVER bundle
				// only (the leak-free corpus never enters the client graph), so on a csr=false doc page it
				// ships on no stylesheet. Extract that scoped CSS here and emit it as a client asset.
				//
				// Compiled with `svelte.compile` on the post-mdsvex source the scanner captured — so
				// Svelte resolves `:global` (a raw `:global` would crash the CSS minifier) and mints the
				// SAME scoped hash the SSR'd HTML carries (default `cssHash` = hash of the CSS; the `.svx`
				// bodies use plain `<style>`, so vitePreprocess is a no-op and the source matches). No JS,
				// no chunk, no corpus in the client graph. Region.svelte links it via the handoff
				// (writeBundle maps content_css_key → the emitted `.css` by referenceId).
				content_css_refs.clear();
				if (islandBridge.contentStyleSources.size) {
					const { compile } = await import('svelte/compiler');
					for (const [abs, source] of islandBridge.contentStyleSources) {
						try {
							const { css } = compile(source, {
								filename: abs,
								css: 'external',
								dev: false,
								generate: 'client',
								experimental: { async: true }
							});
							if (css?.code) {
								const ref = this.emitFile({ type: 'asset', name: 'og-content.css', source: css.code });
								content_css_refs.set(content_css_key(abs), ref);
							}
						} catch {
							/* a content file whose CSS can't be extracted just goes unstyled — the fix must
							   never break a build. */
						}
					}
				}
			}

		},

		configureServer(server) {
			vite_server = server;
		},

		watchChange(id, change) {
			// Unlink often skips handleHotUpdate; drop islands that still import the deleted file.
			if (!is_dev || change.event !== 'delete' || !vite_server) return;
			if (!invalidate_islands_for_file(id, { deleted: true, server: vite_server })) return;
			vite_server.ws.send({ type: 'full-reload', path: '*' });
		},

		buildEnd() { if (__P) { const keys = [...__outHash.keys()].sort(); let d = 0x811c9dc5; for (const k of keys) { d ^= __outHash.get(k)!; d = Math.imul(d, 0x01000193) >>> 0; } console.error('\n[ogygia-prof] ' + JSON.stringify({ ...__prof, transformDigest: (d >>> 0).toString(16), transformFiles: keys.length })); } },
		handleHotUpdate({ file, server }) {
			if (!is_dev) return;
			vite_server = server;

			// SCOPED soft CSS HMR. App css joins the browser graph LAZILY (see dev_hmr_client_source):
			//  - already joined on a client → fall through to Vite's normal CSS update (soft);
			//  - not joined anywhere → suppress Vite's no-boundary full reload and broadcast a scoped
			//    join event instead; each open page joins ONLY css its own route scope imports, so the
			//    `(docs)` and `playground` sub-apps can never paint each other in dev.
			if (DEV_CSS_FILE_RE.test(file) && !file.includes('/node_modules/')) {
				const src_prefix = path.join(root, 'src') + path.sep;
				if (path.normalize(file).startsWith(src_prefix)) {
					const envs = (server as unknown as {
						environments?: Record<string, { moduleGraph?: { getModulesByFile?: (f: string) => Set<DevGraphModule> | undefined } }>;
					}).environments;
					const client_graph = envs?.client?.moduleGraph;
					const joined = client_graph?.getModulesByFile?.(file)?.size ?? 0;
					if (!joined) {
						const owners = derive_css_scope_owners(file, root, [envs?.ssr?.moduleGraph, client_graph]);
						const web_path = '/' + path.relative(root, file).split(path.sep).join('/');
						server.ws.send({ type: 'custom', event: 'ogygia:css', data: { path: web_path, owners } });
						return [];
					}
					return; // client owns the module — Vite's own soft update handles it
				}
			}

			// Island ids are hash(componentPath+strategy) — renaming a host keeps the same virtual
			// id, so Vite's moduleGraph must be cleared or it keeps serving the old import.
			const deleted = !fs.existsSync(strip_id(file));
			const host_changed = !deleted && is_registered_host(file);
			const entry_changed =
				!deleted && needs_island_entry_full_reload(file, registry.values());
			if (host_changed || deleted) {
				invalidate_islands_for_file(file, { deleted, server });
			}

			// Soft CSS HMR via virtual:ogygia/dev-hmr. Route shells + island host rewrites +
			// island entry component edits + deleted entry components need a document reload.
			if (
				!needs_csr_false_full_reload(file) &&
				!deleted &&
				!host_changed &&
				!entry_changed
			) {
				return;
			}
			server.ws.send({ type: 'full-reload', path: '*' });
			return [];
		},

		async resolveId(source, importer, options) {
			// deep-import Kit's own wire helpers by absolute path (bypasses the exports map)
			if (source === V_KIT_WIRE && kit_wire_path) return kit_wire_path;

			// ogygia's OWN injected imports (`ogygia/internal` / `…/server`, written by the transform into
			// a host or a generated island module) resolve to ogygia's own files DIRECTLY (see
			// OGYGIA_INJECTED_FILES) — never via `this.resolve` (unreliable off a synthetic importer, can
			// throw in rolldown-vite) or `config.root` (can be undefined on a throwaway plugin instance).
			// Deterministic, can't throw, can't be left unresolved, works from any sub-package with no
			// ogygia dependency of its own.
			if (OGYGIA_INJECTED_IMPORTS.has(source)) return OGYGIA_INJECTED_FILES[source];

			const ssr = options?.ssr === true;

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
				if (KIT_REMOTE_CLIENT.test(source)) return STUB_CLIENT;
				if (KIT_REMOTE_STATE.test(source)) return STUB_STATE;
			}
			if (!ssr && source === '$app/paths/internal/client') return STUB_PATHS;

			// Everything else — the ogygia virtual-module vocabulary + the island CLIENT graph ($app/*
			// shims, virtual entry ids, relative-to-host + transitive-dep resolution) — is the driver's,
			// with Vite's own resolver threaded in for the two branches that need it.
			return compiler.resolve_id(source, importer, {
				ssr,
				resolve: (s, i, o) => this.resolve(s, i, o)
			});
		},

		load(id, options) {
			// Per-request only. `config.build.ssr` stays set for Kit apps and must NOT decide
			// client vs server virtuals — that leaked `$app/server` into the browser guard.
			const ssr = options?.ssr === true;

			const fouc_bare = id.startsWith('\0') ? id.slice(1) : id;
			if (isFoucCssId(fouc_bare)) {
				const rel = foucRelFromId(fouc_bare);
				if (!rel) {
					return { code: 'export {}', moduleSideEffects: false };
				}
				const abs = path.join(root, rel);
				const code = buildFoucCssModuleSource(abs, {
					root,
					libDir,
					readFile: (p) => {
						try {
							return fs.readFileSync(p, 'utf8');
						} catch {
							return null;
						}
					}
				});
				// Must not tree-shake: the only purpose of this module is CSS side effects.
				return { code, moduleSideEffects: true };
			}
			if (isFoucScopedId(fouc_bare)) {
				const rel = foucRelFromId(fouc_bare);
				if (!rel) return { code: '', moduleType: 'css' };
				const abs = path.join(root, rel);
				let source = '';
				try {
					source = fs.readFileSync(abs, 'utf8');
				} catch {
					return { code: '', moduleType: 'css' };
				}
				return { code: compileFoucScopedCss(abs, source), moduleType: 'css' };
			}

			// Every other ogygia virtual is a pure `id → source` emit the driver owns. The two Vite build
			// values it can't see are threaded in: the client-leg content-hashed runtime URL (handoff) and
			// the app's universal-hooks path (discovered in configResolved).
			return compiler.emit(id, {
				ssr,
				hashedRuntimeUrl: hashed_runtime_url,
				universalHooks: universal_hooks
			});
		},

		async transform(code, id, options) {
			const ssr = options?.ssr === true;
			// Discover islands before any module is transformed so island_graph is populated
			// even when an island entry component is processed before its host page.
			compiler.prescan();

			const id_n = strip_id(id);

			// (There is deliberately NO csr=false route-client stripping here. Kit collects a route's
			// CSS manifest from the CLIENT graph — stubbing those modules silently drops every component
			// stylesheet from the prerendered pages. Keeping the corpus out of client bundles is the
			// `.server.ts` placement rule's job — see the content-placement warning — and Kit enforces
			// it mechanically; a csr=false page never fetches its route JS anyway, so the dead client
			// nodes cost disk, not wire.)
			let out = code;
			let map = null;
			let touched = false;

			// CONTENT-PRESET module variant (`?og_preset=name`, minted by a loader macro's glob query).
			// vite-plugin-svelte strips the query from the `filename` its preprocessors see, so the id
			// can't carry the preset that far — instead this pre-transform (which DOES see the full id)
			// tags the raw markdown with a one-line end-of-file marker; the markdown preprocessor reads
			// it, strips it, and compiles with the preset's merged config. Appended at the END so
			// frontmatter stays on line one; mdsvex never sees it (stripped first).
			if (islandBridge.contentPresets && id.includes('og_preset=')) {
				const m = /[?&]og_preset=([\w-]+)/.exec(id);
				const md_exts = (islandBridge.markdownConfig?.extensions as string[] | undefined) ?? ['.svx', '.md'];
				const file_part = id.slice(0, id.indexOf('?'));
				if (m && md_exts.some((e) => file_part.endsWith(e))) {
					if (!islandBridge.contentPresets[m[1]]) {
						throw new Error(
							`[ogygia] '${id}': unknown content preset '${m[1]}' in the module query. Configured: ${Object.keys(islandBridge.contentPresets).join(', ')}.`
						);
					}
					out = `${out}\n<!--og_preset:${m[1]}-->`;
					touched = true;
				}
			}

			// The `import.meta.og.*` module macros — `wire`/`$`/`store`/auto-brand/`code`/`bake`, in
			// that order — all landing BEFORE either branch (island transform / svelte compile / ts
			// region minting) sees the code, so a computed codec key is a real symbol, a hoisted fn is
			// a ref, a baked call is plain data, and an inlined snippet flows through as a region. Each
			// pass is a no-op unless its exact marker is present. Owned by the driver (`compiler.macros`,
			// which fills `compiler.dollar_hoists` for the fn-manifest emit and records the bake timing).
			const macroed = await compiler.macros(out, id_n);
			if (macroed.touched) {
				out = macroed.code;
				map = null; // any macro rewrite invalidates a prior sourcemap
				touched = true;
			}

			// App `.svelte` always; a node_modules `.svelte` ONLY if it carries an ogygia hint (so a
			// library can declare its own islands — Shell → ShellBar). `is_island_path` still
			// excludes GENERATED island glue (wrappers, region bindings, plain re-export entries) —
			// but a PORTABLE SNIPPET entry is authored markup (a slice of user source) and MUST be
			// re-processed: its `with { wake }` imports become nested islands, and nested snippets
			// re-portable-ize. Normalize the dev `/@id/` prefix so dev and build take the SAME gate
			// (dev previously transformed these only because the prefix slipped past the exclusion —
			// which is why islands inside snippets worked in dev and died in prod).
			const in_node_modules = id_n.includes('/node_modules/');
			const bare_v = id_n.startsWith('/@id/') ? id_n.slice(5) : id_n;

			// `import.meta.og.loader.*` is SERVER-ONLY — it materializes a corpus, which must never
			// reach a client bundle (that's the `.server.ts` placement rule). A component can't hold
			// one: the rewrite only runs on `.ts/.js/.mjs`, so a loader in `.svelte` would silently
			// stay un-rewritten and explode at runtime. Warn loudly with the fix instead.
			if (id_n.endsWith('.svelte') && !in_node_modules && out.includes('import.meta.og.loader.')) {
				console.warn(
					`[ogygia/content] ${path.relative(root, bare_v)} calls import.meta.og.loader.* inside a component. ` +
						`Loaders build a content corpus and are server-only — move the collection to a \`.server.ts\` ` +
						`module and cross the wire with remotes. (In a component it never rewrites and fails at runtime.)`
				);
			}
			const portable_entry =
				id_n.endsWith('.svelte') && is_island_path(bare_v) && registry.get(bare_v)?.portable === true;
			if (
				id_n.endsWith('.svelte') &&
				(!is_island_path(bare_v) || portable_entry) &&
				(!in_node_modules || has_island_hint(code))
			) {
				// Pass Vite's ssr flag through — client csr=false hosts omit wrapper links.
				// `out`, NOT `code`: the wire/code/md/bake rewrites above already landed in `out`, and
				// the island transform's result REPLACES it — feeding it `code` would silently discard
				// them for any component the host transform touches (import.meta.og.code in a .svelte
				// stayed un-rewritten and exploded at runtime as `undefined.code`).
				const result = run_transform(out, id_n, { ssr });
				if (result) {
					register(result, id_n);
					out = result.code;
					map = result.map;
					touched = true;

					// Emit the deterministic island chunk for any hydrate island discovered HERE that the
					// buildStart prescan couldn't see — i.e. declared inside a library component (host
					// outside the app's `src`). Without this the client leg lets Rolldown content-hash the
					// entry, diverging from the deterministic name SSR baked into `<ogygia-region entry>`.
					if (is_build && !ssr) {
						for (const isl of result.islands ?? []) {
							const kind = isl.kind ?? (isl.server ? 'defer' : 'hydrate');
							if (kind !== 'hydrate' || !isl.virtualPath || emitted_island_chunks.has(isl.id)) continue;
							emitted_island_chunks.add(isl.id);
							this.emitFile({ type: 'chunk', id: isl.virtualPath, fileName: islandChunkFileName(isl.id) });
						}
					}
				}

				// A transportable class can live in this component's `<script module>` — register it
				// (same tag scheme, keyed by the `.svelte` path) so it travels like a `.svelte.ts` one.
				if (!id_n.startsWith(PKG_ROOT)) {
					const withReg = appendSvelteModuleRegistrations(out, id_n, root, path);
					if (withReg !== null) {
						out = withReg;
						map = null; // injected into the module script — prior map no longer aligns
						touched = true;
					}
				}
			}

			// `.ts` / `.js` region minting (load / remote functions): rewrite `with { wake: … }`
			// imports. Runs before rolldown's core transform (enforce:'pre') so the attribute is
			// stripped before it would trip the parser.
			if (
				(id_n.endsWith('.ts') || id_n.endsWith('.js') || id_n.endsWith('.mjs')) &&
				!id_n.includes('/node_modules/') &&
				!is_island_path(id_n)
			) {
				warn_content_placement(id_n, out);

				// `import.meta.og.loader.*` — the compiler content constructs (like import.meta.glob).
				// Rewrite each to its runtime builder wrapping the glob; `git` first materializes a
				// shallow checkout into the app's content cache (sync, idempotent, lock-gated) and points
				// the glob at it. Runs BEFORE Vite's glob plugin scans the emitted pattern, so the files
				// are already on disk. (Keeping the corpus out of client bundles is the `.server.ts`
				// placement rule — see the content-placement warning above; Kit's server-module guard
				// enforces it mechanically.)
				if (out.includes('import.meta.og.loader.')) {
					const { code: rewritten, specs } = rewrite_loaders(out);
					if (rewritten !== out) {
						for (const spec of specs) materialize(spec, { root });
						out = rewritten;
						map = null; // injected import + call rewrite invalidates any prior map
						touched = true;
					}
				}

				// `import.meta.og.regions(glob)` — the block registry. Globs the pattern at build and
				// injects one `with { region: 'raw' }` import per match, assembling a basename-keyed
				// registry. Runs BEFORE transformTsRegions so the injected region imports flow through
				// the island transform exactly like hand-authored ones.
				if (out.includes('import.meta.og.regions')) {
					const rewritten = rewrite_regions(out, id_n);
					if (rewritten !== out) {
						out = rewritten;
						map = null;
						touched = true;
					}
				}

				const result = compiler.ts_regions(out, id_n);
				if (result) {
					register(result, id_n);
					out = result.code;
					map = result.map;
					touched = true;
				}

				// Transportable classes: append tag registration for `[ogygia.TRANSPORT]` codecs.
				// Skip ogygia's own source (workspace dev links it outside node_modules; appending
				// an `import 'ogygia'` there would create an eval cycle). Append-only → map survives.
				if (!id_n.startsWith(PKG_ROOT)) {
					const registered = appendTransportRegistrations(out, id_n, root, path);
					if (registered !== null) {
						out = registered;
						touched = true;
					}
				}
			}

			// CLIENT: rewrite `$app/(state|stores|navigation)` inside island entry components
			// (and any other island_graph .svelte) to absolute shim paths. Absolute paths bypass
			// Kit's `$app/*` alias entirely — needed when an island's own component graph imports
			// `$app/*` (csr=true hosts still pass virtual islands as `__component`).
			if (!ssr && island_graph.has(id_n) && id_n.endsWith('.svelte')) {
				const rewritten = out.replace(
					APP_SHIM_IMPORT,
					(_m, _q, name) => JSON.stringify(APP_SHIMS['$app/' + name])
				);
				if (rewritten !== out) {
					out = rewritten;
					map = null; // import path rewrite invalidates a prior sourcemap
					touched = true;
				}
			}

			return touched ? { code: out, map } : null;
		},

		renderChunk(code) {
			// Patch the fn-manifest placeholder now — every transform has run, so `dollar_hoists`
			// is complete. Pre-minify (this plugin is enforce:pre) and rename-proof (registrations
			// go through the globalThis bridge the placeholder module installed).
			if (!code.includes('/*__OGYGIA_FN_MANIFEST__*/')) return null;
			const regs = [...compiler.dollar_hoists.entries()]
				.map(([tag, src]) => `globalThis.__og_reg_fn(${JSON.stringify(tag)}, (${src}));`)
				.join('\n');
			// FUNCTION-form replacement: factory sources legitimately contain `$$` (a literal `$`
			// before a template hole), which String.replace would collapse in a string replacement.
			return { code: code.replace('/*__OGYGIA_FN_MANIFEST__*/', () => regs), map: null };
		},

		writeBundle(_options, bundle) {
			// Client only — Kit builds SSR first, so Region.svelte reads this JSON at render
			// (prerender / live SSR), not at SSR-bundle `load()` time.
			//
			// `writeBundle` (not `generateBundle`): rolldown merges/eliminates shared chunks AFTER
			// `generateBundle`, so a chunk's `imports` there can name a phantom that's gone by write.
			// By `writeBundle` the bundle reflects the files actually on disk.
			if (!is_build || is_ssr) return;

			warn_content_leaks(bundle as Record<string, unknown>, root, is_island_path);

			const map = collectIslandDepModulepreloads(
				bundle as Record<
					string,
					{
						type: string;
						fileName?: string;
						imports?: string[];
						dynamicImports?: string[];
						viteMetadata?: { importedCss?: Set<string> | string[] };
					}
				>
			);
			// Content-body CSS handoff: content_css_key → the emitted CSS asset URL, so Region.svelte can
			// link a content body's own scoped CSS (which lives on no page stylesheet — the corpus is
			// server-only). The client leg emitted each as an asset and stashed its referenceId; resolve
			// to the hashed filename now that the bundle is finalized. Same key the preprocessor baked
			// as `__ogygia_css`, so the body region resolves it at SSR.
			const content_css: Record<string, string[]> = {};
			for (const [key, ref] of content_css_refs) {
				try {
					const file = this.getFileName(ref);
					content_css[key] = [file.startsWith('/') ? file : '/' + file];
				} catch {
					/* asset dropped — skip; the body just goes unstyled rather than 404 a link */
				}
			}

			const json = JSON.stringify({ ...map, content_css, fn_manifest: Object.fromEntries(compiler.dollar_hoists) });
			emit_island_deps_handoff(root, json);
		}
		},
		island_sourcemaps_plugin({ program, is_island_path })
	];
}

/**
 * ogygia's svelte preprocessor. Spread into the svelte config's `preprocess`:
 *
 * ```js
 * extensions: ogygia.extensions(),
 * preprocess: [vitePreprocess(), ...ogygia.preprocess()],
 * ```
 *
 * Synchronous (no `await`) — returns the markdown preprocessor when `ogygia({ content: { markdown } })`
 * is set, otherwise an empty array. mdsvex (an optional peer) loads lazily on first use, so this is
 * safe to import and call even without it installed.
 *
 * `ogygia({ content: { markdown } })` must appear earlier in the plugins array so its config is
 * registered before this reads it (it does, being before `sveltekit()`).
 */
ogygia.preprocess = (): PreprocessorGroup[] =>
	islandBridge.markdownConfig ? [ogygiaPresetPreprocess()] : [];

/**
 * The full svelte `extensions` list — pass it straight through: `extensions: ogygia.extensions()`.
 * Always includes `.svelte`; adds `.svx` / `.md` when `ogygia({ content: { markdown } })` is set.
 */
ogygia.extensions = (): string[] =>
	islandBridge.markdownConfig ? ['.svelte', '.svx', '.md'] : ['.svelte'];
