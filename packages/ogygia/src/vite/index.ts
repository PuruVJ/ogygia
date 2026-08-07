import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import {
	transformHost,
	ISLAND_DIR,
	normalize_import_keys,
	islandChunkFileName,
	wrapperVirtualId,
	CLIENT_BINDING_STUB,
	type ImportKeys
} from './transform.js';
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
} from './transform.js';
export type { ImportKeys } from './transform.js';
import { allRoutesCsrFalse, routeCsrIsFalse, runStandaloneClientBuild } from './standalone.js';
import { DEFAULT_REGION_TTL_SEC } from '../server/endpoint.js';
import {
	derive_id_salt,
	secret_has_min_entropy,
	MIN_SECRET_BYTES
} from '../server/hmac.js';
import {
	FOUC_CSS_PREFIX,
	FOUC_SCOPED_PREFIX,
	buildFoucCssModuleSource,
	compileFoucScopedCss,
	foucRelFromId,
	isFoucCssId,
	isFoucScopedId
} from './fouc-css.js';

const RUNTIME_ENTRY = fileURLToPath(new URL('../runtime/index.js', import.meta.url));
/** `packages/ogygia` — Vite must serve absolute shim/runtime resolves from outside the app root. */
const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

const V_RUNTIME_URL = 'virtual:ogygia/runtime-url';
const V_MANIFEST = 'virtual:ogygia/manifest';
const V_RUNTIME = 'virtual:ogygia-runtime';
const V_DEV_HMR = 'virtual:ogygia/dev-hmr';
const V_DEV_HMR_URL = 'virtual:ogygia/dev-hmr-url';
const V_ISLAND_DEPS = 'virtual:ogygia/island-deps';
const V_SECRET = 'virtual:ogygia/secret';
const V_SIGN = 'virtual:ogygia/sign';
const V_RATE_LIMIT = 'virtual:ogygia/rate-limit';
const V_SESSION_COOKIE = 'virtual:ogygia/session-cookie';
const V_REGION_TTL = 'virtual:ogygia/region-ttl';
const V_SERVER_MANIFEST = 'virtual:ogygia/server-manifest';
const V_REQUEST_EVENT = 'virtual:ogygia/request-event';
const V_REGION_ENDPOINT = 'virtual:ogygia/region-endpoint';
const V_CLIENT_BINDING_STUB = CLIENT_BINDING_STUB;
// Reuse Kit's OWN wire protocol (transport-aware devalue arg/response codec) instead of
// reimplementing it. We deep-import Kit's internal `runtime/shared.js` by absolute path
// (bypassing the exports map) and feed it the app's universal `transport` hook.
const V_KIT_WIRE = 'virtual:ogygia/kit-wire';
const V_TRANSPORT = 'virtual:ogygia/transport';
const RESOLVED = (id) => '\0' + id;

/** Absolute path to SSR region-endpoint helper (signed capability URLs). */
const REGION_ENDPOINT_MODULE = fileURLToPath(new URL('../server/region-endpoint.js', import.meta.url));

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

const TRAILING_SLASH = /\/$/;
const KIT_REMOTE_CLIENT = /(^|\/)client\.js$/;
const KIT_REMOTE_STATE = /state\.svelte\.js$/;
const LEADING_SLASH = /^\//;
/** Rewrite `$app/{state,stores,navigation}` string literals to absolute shim paths. */
const APP_SHIM_IMPORT = /(['"])\$app\/(state|stores|navigation)\1/g;

/**
 * Rewrite a lake binding's import to the render-nothing placeholder (client island modules only).
 * Default imports are repointed; named imports drop that specifier (and keep siblings) then add a
 * default import of the placeholder under the same local name.
 *
 * @internal Used by the plugin client transform and unit tests.
 */
export function rewrite_lake_import_to_placeholder(src: string, local: string, placeholder: string) {
	const esc = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const ph = JSON.stringify(placeholder);
	// default: import Lake from '…'
	src = src.replace(
		new RegExp(`import\\s+${esc}\\s+from\\s+(['"])[^'"]+\\1`, 'g'),
		`import ${local} from ${ph}`
	);
	// named: import { Lake } / { Lake as X } / { Foo as Lake } from '…'
	src = src.replace(
		new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])([^'"]+)\\2`, 'g'),
		(full, specs, _q, from) => {
			const parts = String(specs)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			const kept = [];
			let hit = false;
			for (const p of parts) {
				const m = p.match(/^(.+?)(?:\s+as\s+(\w+))?$/);
				if (!m) {
					kept.push(p);
					continue;
				}
				const imported = m[1].trim();
				const alias = (m[2] || imported).trim();
				if (alias === local) {
					hit = true;
					continue;
				}
				kept.push(p);
			}
			if (!hit) return full;
			const named = kept.length ? `import { ${kept.join(', ')} } from ${JSON.stringify(from)};` : '';
			return `import ${local} from ${ph};${named ? '\n\t' + named : ''}`;
		}
	);
	return src;
}

/**
 * Host route shells (`+page` / `+layout` / …) never join the browser module graph under
 * `csr=false`, so Vite's fine-grained HMR for them has no client importer. Force a full reload.
 * Standalone CSS is soft-updated via `virtual:ogygia/dev-hmr` (Vite inject after Kit FOUC).
 * If that soft path fails, the client bridge listens for `vite:error` and reloads the document.
 *
 * @internal HMR policy helper (also covered by unit tests).
 */
export function needs_csr_false_full_reload(file: string) {
	const norm = file.replace(/\\/g, '/');
	if (/\.(css|scss|sass|less|styl)(?:$|\?)/i.test(norm)) return false;
	return /(?:^|\/)\+(?:page|layout|error|server|hooks)(?:\.|$)/.test(norm);
}

/**
 * Island entry `.svelte` files (the `import X from '…' with { hydrate }`) sit behind a virtual
 * wrapper; Svelte soft HMR through that edge is unreliable. Shared `.ts` deps still soft-update.
 *
 * @internal HMR policy helper (also covered by unit tests).
 */
export function needs_island_entry_full_reload(
	file: string,
	entries: Iterable<{ componentPath?: string | null }>
) {
	const bare = file.split('?')[0];
	if (!bare.endsWith('.svelte')) return false;
	if (/\.(css|scss|sass|less|styl)(?:$|\?)/i.test(bare.replace(/\\/g, '/'))) return false;
	for (const entry of entries) {
		if (same_module_path(entry.componentPath, file)) return true;
	}
	return false;
}

/**
 * Absolute path equality with querystrings stripped (host vs component vs Vite watch paths).
 * @internal
 */
export function same_module_path(a: string | null | undefined, b: string | null | undefined) {
	if (!a || !b) return false;
	return path.resolve(a.split('?')[0]) === path.resolve(b.split('?')[0]);
}

/**
 * Virtual island ids whose generated source must be dropped when `file` changes or is deleted.
 * Island ids are `hash(componentPath\\0strategyKey)` — renaming a host route keeps the same id, so
 * Vite's moduleGraph must be invalidated or it keeps serving the old import.
 *
 * @internal HMR invalidation helper (also covered by unit tests).
 */
export function island_vpaths_affected_by_file(
	file: string,
	entries: Iterable<[string, { hostPath?: string | null; componentPath?: string | null }]>
) {
	const out: string[] = [];
	for (const [vpath, entry] of entries) {
		if (same_module_path(entry.hostPath, file) || same_module_path(entry.componentPath, file)) {
			out.push(vpath);
		}
	}
	return out;
}

/**
 * Client bridge source for `virtual:ogygia/dev-hmr` (vite serve only): joins app CSS under
 * `/src` into the browser graph via `import.meta.glob`, and full-reloads on `vite:error`.
 *
 * Do **not** strip Kit’s `<style data-sveltekit>` FOUC bag. Under `csr = false` that bag is
 * how page + component CSS is delivered (no client module graph for route shells). Removing
 * it blanks the page; a MutationObserver would also delete FOUC styles the SPA router merges
 * in on navigation.
 *
 * @internal Emitted by the plugin; exported for unit tests.
 */
export function dev_hmr_client_source() {
	return (
		`import "/@vite/client";\n` +
		`import.meta.glob("/src/**/*.{css,scss,sass,less,styl}", { eager: true });\n` +
		`// Soft path: CSS modules via Vite HMR (injected after FOUC; later rules win).\n` +
		`// Hard path: anything Vite can't apply.\n` +
		`function ogygia_full_reload() {\n` +
		`  location.reload();\n` +
		`}\n` +
		`if (import.meta.hot) {\n` +
		`  import.meta.hot.accept();\n` +
		`  import.meta.hot.on("vite:error", ogygia_full_reload);\n` +
		`}\n`
	);
}

/** Virtual island ENTRY module id — JS re-export of the real component (not a thin .svelte). */
export const islandVirtualId = (iid: string) => `virtual:ogygia/island/${iid}.js`;

/** Re-export portable wrapper id helper (marked import binding target). */
export { wrapperVirtualId };

/** Deterministic island facade filename (content-hashed Vite deps are separate). */
const ISLAND_FACADE_RE = /(?:^|\/)ogygia-island\.[0-9a-f]+\.js$/;

/**
 * From a client `generateBundle` output, collect transitive static `imports` for each
 * `ogygia-island.<id>.js` facade. Keys/values are public URLs (`/_app/immutable/…`).
 * Used so SSR can `modulepreload` hashed dependency chunks for `hydrate: 'load'` islands
 * (Vite’s auto graph does not apply to `@vite-ignore` `import(entry)`).
 *
 * @internal Exported for unit tests.
 */
export function collectIslandDepModulepreloads(
	bundle: Record<
		string,
		{ type: string; fileName?: string; imports?: string[]; dynamicImports?: string[] }
	>
): Record<string, string[]> {
	const out: Record<string, string[]> = {};

	const walk = (fileName: string, seen: Set<string>): string[] => {
		const chunk = bundle[fileName];
		if (!chunk || chunk.type !== 'chunk') return [];
		const deps: string[] = [];
		for (const imp of chunk.imports ?? []) {
			if (seen.has(imp)) continue;
			seen.add(imp);
			deps.push(imp.startsWith('/') ? imp : '/' + imp);
			deps.push(...walk(imp, seen));
		}
		return deps;
	};

	for (const [key, chunk] of Object.entries(bundle)) {
		if (chunk.type !== 'chunk') continue;
		const fileName = chunk.fileName || key;
		if (!ISLAND_FACADE_RE.test(fileName)) continue;
		const entryUrl = fileName.startsWith('/') ? fileName : '/' + fileName;
		const seen = new Set<string>([fileName]);
		const raw = walk(fileName, seen);
		const uniq: string[] = [];
		const have = new Set<string>([entryUrl]);
		for (const d of raw) {
			if (have.has(d)) continue;
			have.add(d);
			uniq.push(d);
		}
		out[entryUrl] = uniq;
	}
	return out;
}

/** Stable handoff path: client `generateBundle` writes; SSR reads at render (Kit is SSR-first). */
export function islandDepsHandoffPath(root: string) {
	return path.join(root, '.svelte-kit', 'ogygia-island-deps.json');
}

function is_island_path(id: string) {
	const bare = id.split('?')[0];
	return (
		(bare.startsWith('virtual:ogygia/island/') &&
			(bare.endsWith('.js') || bare.endsWith('.svelte'))) ||
		(bare.startsWith('virtual:ogygia/wrapper/') && bare.endsWith('.svelte')) ||
		// legacy on-disk path shape (pre-virtual ids); still recognize for resolve/HMR edge cases
		(bare.includes('/' + ISLAND_DIR + '/') && bare.endsWith('.svelte'))
	);
}

/**
 * Lake remount policy for `hydrate: 'none'` presets.
 *
 * - `'cache'` — restore the SSR DOM snapshot on remount (default)
 * - `'empty'` — remount vacant; optional `onExpire: 'fetch'` can refill
 * - `'swr'` — show cache while revalidating via the signed region endpoint
 */
export type OgygiaRemount =
	| 'cache'
	| 'empty'
	| 'swr'
	| {
			/** Schedule for SWR revalidation (`false` disables). Same words as hydrate/defer. */
			revalidate?: false | string;
			/** Max age before expiry (ms number or duration string like `'10m'`). */
			maxAge?: number | string;
			/** What happens when the cached lake expires: clear or refetch. */
			onExpire?: 'empty' | 'fetch';
	  };

/**
 * Named strategy bundle referenced from source via `with { preset: 'name' }`
 * (or the renamed `importKeys.preset` key).
 *
 * Field names here are always canonical (`hydrate` / `defer` / …) even when
 * {@link OgygiaOptions.importKeys} renames the **import-attribute** spellings.
 */
export interface OgygiaPreset {
	/**
	 * Client hydrate schedule: `'load'` | `'idle'` | `'visible'` | a CSS media query |
	 * `'none'` (lake). Mutually exclusive with {@link defer} on the same preset.
	 */
	hydrate?: string;
	/**
	 * Server-island fetch schedule: `'load'` | `'idle'` | `'visible'` | a CSS media query.
	 * Mutually exclusive with {@link hydrate} on the same preset.
	 */
	defer?: string;
	/** `IntersectionObserver` `rootMargin` when the schedule is `'visible'`. */
	margin?: string;
	/** Lake-only (`hydrate: 'none'`). See {@link OgygiaRemount}. */
	remount?: OgygiaRemount;
}

/** Per-IP budget for the signed deferred-region / lake-remount endpoint. */
export interface OgygiaRateLimit {
	/** Max requests per window (default `60`). `0` disables allowing any. */
	max?: number;
	/** Sliding window length in milliseconds (default `60_000`). */
	windowMs?: number;
}

/**
 * Options for the {@link ogygia} Vite plugin.
 *
 * @example
 * ```ts
 * import { ogygia } from 'ogygia/vite';
 * export default defineConfig({
 *   plugins: [
 *     ogygia({
 *       visible: { margin: '200px' },
 *       presets: { chart: { hydrate: 'visible', margin: '200px' } },
 *       regionTtl: 3600
 *     }),
 *     sveltekit()
 *   ]
 * });
 * ```
 */
export interface OgygiaOptions {
	/**
	 * Global defaults for islands that use `hydrate: 'visible'` / `defer: 'visible'`
	 * without their own `margin` (via a preset).
	 */
	visible?: {
		/** Default `IntersectionObserver` `rootMargin` (e.g. `'200px'`). */
		margin?: string;
	};

	/**
	 * Rename the import-attribute keys claimed by the transform.
	 * Defaults stay `hydrate` / `defer` / `preset`. Escape hatch if another tool already
	 * uses those names on the same imports.
	 *
	 * Preset **definitions** ({@link presets}) still use canonical `hydrate` / `defer` /
	 * `margin` / `remount` — only the `with { … }` spellings in source change.
	 */
	importKeys?: Partial<ImportKeys>;

	/**
	 * Named strategy bundles. Reference one from an import:
	 * `import Chart from '$lib/Chart.svelte' with { preset: 'chart' };`
	 */
	presets?: Record<string, OgygiaPreset>;

	/**
	 * Per-IP budget for the signed island endpoint served by `ogygiaHandle()`.
	 * Default `{ max: 60, windowMs: 60_000 }`. Pass `false` to disable.
	 */
	rateLimit?: false | OgygiaRateLimit;

	/**
	 * Cookie name to seal into the region MAC (opt-in). Empty/prerender stays unbound.
	 * Harvested capability URLs then fail verification without that cookie.
	 * Default `false` (unbound).
	 */
	sessionCookie?: false | string;

	/**
	 * Capability URL lifetime in seconds (default `3600`). Clamped to `[60, 86400]`.
	 * Keep short for harvested-URL risk; raise only if long-lived tabs must keep deferred holes valid.
	 */
	regionTtl?: number;

	/**
	 * @internal Recreate this plugin instance inside the standalone client build.
	 * App authors should not set this.
	 */
	standalone?: boolean;
}

/**
 * Rewrite vite-plugin-svelte island sourcemap `sources` so Vite treats them as virtual.
 *
 * Svelte emits the basename of `virtual:ogygia/island/<id>.svelte` (just `<id>.svelte`).
 * That string does not match Vite's `virtualSourceRE`, so `injectSourcesContent` tries a
 * disk read and warns "points to missing source files". Pointing sources back at the
 * full virtual module id silences the warning (and keeps maps coherent).
 *
 * @internal Also covered by unit tests.
 */
export function rewrite_island_sourcemap_sources(
	moduleId: string,
	sources: (string | null)[] | undefined
) {
	if (!sources?.length) return null;
	let changed = false;
	const next = sources.map((s) => {
		if (typeof s !== 'string') return s;
		if (s === moduleId || s.startsWith('virtual:') || s.includes('\0')) return s;
		// Basename-only (or other relative) .svelte source for this virtual module.
		if (s.endsWith('.svelte') && !s.includes('/') && !path.isAbsolute(s)) {
			changed = true;
			return moduleId;
		}
		return s;
	});
	return changed ? next : null;
}

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
	const visibleMargin = options.visible?.margin;
	const presets = options.presets || {};
	const import_keys = normalize_import_keys(options.importKeys);

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

	// HMAC key for signing region capability URLs (defer / remount:swr). Default: a fresh
	// per-build random baked into the SERVER bundle only (never a client chunk). Optional
	// `OGYGIA_SECRET` overrides that so rolling deploys / long-lived cached HTML keep verifying.
	// Sign/verify HKDF-derive a MAC key from this material (`ogygia-mac-v1`).
	const build_secret = crypto.randomBytes(32).toString('hex');
	/** Salt for region ids — HKDF from stable env only (never per-build random, or SSR/client
	 *  builds would disagree). Empty when unset (dev + default per-build signing). */
	let id_salt = '';

	/** @type {Map<string, {source:string, hostPath:string, id:string, componentPath?: string | null, server?: boolean, lakes?: string[], role?: 'entry'|'wrapper'}>} keyed by virtual path */
	const registry = new Map();
	/** Absolute module ids in an island's CLIENT dependency graph. `$app/*` resolves to shims
	 *  for these importers (virtual island module AND its transitive component imports). */
	const island_graph = new Set();
	const strip_id = (id) => (id ? id.split('?')[0] : id);
	/** @type {Map<string, string>} iid -> entry virtual path (hydrate / defer / swr-lake) */
	const by_id = new Map();
	/** @type {Map<string, 'hydrate'|'defer'|'lake'>} every region id -> kind (server manifest / emit) */
	const region_kinds = new Map();
	/** host abs path → region ids + virtual paths discovered on last transform of that host */
	const host_index = new Map();
	/** region id → hosts still claiming it (cross-host dedupe: don't drop shared wrappers) */
	const id_hosts = new Map();

	let root;
	let base = '';
	let libDir;
	let is_dev = false;
	let is_build = false;
	let is_ssr = false;
	let scanned = false;
	let sourcemap = false;
	let ran_standalone = false;
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

	const readFile = (abs) => {
		try {
			return fs.readFileSync(abs, 'utf-8');
		} catch {
			return null;
		}
	};

	const virtualPathFor = (_hostId, iid) => islandVirtualId(iid);

	/** Dev URL for dynamic `import(entry)` of a virtual island module. */
	const devUrlFor = (virtualPath) => {
		const prefix = base && base !== '/' ? base.replace(TRAILING_SLASH, '') : '';
		return prefix + '/@id/' + virtualPath;
	};

	const transform_cache = new Map();

	const host_key = (hostPath) => path.resolve(strip_id(hostPath));

	const clear_transform_cache_for = (hostPath) => {
		const key = host_key(hostPath);
		for (const k of [...transform_cache.keys()]) {
			const host = k.includes('\0') ? k.slice(0, k.indexOf('\0')) : k;
			if (host_key(host) === key) transform_cache.delete(k);
		}
	};

	/** Drop this host's claims; shared region ids (cross-host dedupe) stay until unused. */
	const unregister_host = (hostPath) => {
		const key = host_key(hostPath);
		const prev = host_index.get(key);
		if (prev) {
			for (const id of prev.ids) {
				const holders = id_hosts.get(id);
				if (holders) {
					holders.delete(key);
					if (holders.size === 0) {
						id_hosts.delete(id);
						region_kinds.delete(id);
						by_id.delete(id);
					}
				} else {
					region_kinds.delete(id);
					by_id.delete(id);
				}
			}
			for (const vpath of prev.vpaths) {
				const entry = registry.get(vpath);
				if (entry) {
					const holders = id_hosts.get(entry.id);
					if (!holders || holders.size === 0) {
						registry.delete(vpath);
						island_graph.delete(vpath);
					}
				} else {
					registry.delete(vpath);
					island_graph.delete(vpath);
				}
			}
			host_index.delete(key);
		}
		clear_transform_cache_for(hostPath);
	};

	const run_transform = (source, id, opts = {}) => {
		const ssr = opts.ssr !== false;
		// Scale: csr=false CLIENT hosts must not statically import portable wrappers (or the
		// hydrate entries those wrappers pull in). Kit still emits those page nodes; sharing
		// the emitFile module with the page graph forces Rolldown thin `ogygia-island.*`
		// facades. SSR keeps real wrappers for HTML; csr=true client keeps them so Kit can
		// hydrate islands as normal components. Hydration always uses `import(entry)`.
		const link_virtual =
			opts.linkVirtual !== undefined
				? opts.linkVirtual
				: ssr || !routeCsrIsFalse(id, path.join(root, 'src', 'routes'));
		const cache_key = `${id}\0${link_virtual ? '1' : '0'}`;
		const hit = transform_cache.get(cache_key);
		if (hit && hit.code === source) return hit.result;
		const result = transformHost(source, id, {
			root,
			libDir,
			readFile,
			pathModule: path,
			dev: is_dev,
			virtualPathFor,
			wrapperPathFor: (_hostId, iid) => wrapperVirtualId(iid),
			devUrlFor,
			visibleMargin,
			presets,
			importKeys: import_keys,
			idSalt: id_salt,
			linkVirtualIsland: link_virtual,
			clientBindingStub: V_CLIENT_BINDING_STUB
		});
		transform_cache.set(cache_key, { code: source, result });
		return result;
	};

	/** Remove leftover on-disk `.ogygia` trees from an earlier materialization approach. */
	const clean_stale_ogygia_dirs = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			if (entry.name === 'node_modules') continue;
			if (entry.name === ISLAND_DIR) {
				fs.rmSync(full, { recursive: true, force: true });
				continue;
			}
			clean_stale_ogygia_dirs(full);
		}
	};

	/** Replace this host's claims; shared ids keep one registry entry (path+strategy dedupe). */
	const register = (result, hostId) => {
		unregister_host(hostId);
		const key = host_key(hostId);
		const idx = { ids: new Set(), vpaths: new Set() };
		for (const isl of result.islands ?? []) {
			region_kinds.set(isl.id, isl.kind ?? (isl.server ? 'defer' : 'hydrate'));
			idx.ids.add(isl.id);
			let holders = id_hosts.get(isl.id);
			if (!holders) {
				holders = new Set();
				id_hosts.set(isl.id, holders);
			}
			holders.add(key);

			if (isl.wrapperPath && isl.wrapperSource) {
				registry.set(isl.wrapperPath, {
					source: isl.wrapperSource,
					hostPath: isl.hostPath,
					id: isl.id,
					server: false,
					lakes: isl.lakes ?? [],
					componentPath: isl.componentPath ?? null,
					role: 'wrapper'
				});
				idx.vpaths.add(isl.wrapperPath);
				island_graph.add(isl.wrapperPath);
			}
			if (isl.virtualPath && isl.source) {
				registry.set(isl.virtualPath, {
					source: isl.source,
					hostPath: isl.hostPath,
					id: isl.id,
					server: !!isl.server,
					lakes: [],
					componentPath: isl.componentPath ?? null,
					role: 'entry'
				});
				by_id.set(isl.id, isl.virtualPath);
				idx.vpaths.add(isl.virtualPath);
				island_graph.add(isl.virtualPath);
			} else if (isl.virtualPath) {
				by_id.set(isl.id, isl.virtualPath);
			}
			if (isl.componentPath) island_graph.add(isl.componentPath);
		}
		host_index.set(key, idx);
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

	/** Pre-scan every app .svelte so the build manifest is complete before it loads. */
	const prescan = () => {
		if (scanned) return;
		scanned = true;
		const src_dir = path.join(root, 'src');
		clean_stale_ogygia_dirs(src_dir);
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
					if (result) register(result, full);
				}
			}
		};
		walk(src_dir);
	};

	return [
		{
			name: 'ogygia',
			enforce: 'pre',

			config() {
			// Match Kit: SSR-inline `esm-env` so its development/production export conditions
			// resolve per mode (used if anything in our server graph imports it). Do NOT
			// optimizeDeps.exclude it — that breaks Svelte client prebundles that import DEV.
			// `server.fs.allow`: kit-remote stubs / runtime resolve to absolute paths under this
			// package; without it Vite 403s them when the app root is docs/ or playground/.
			return {
				ssr: { noExternal: ['esm-env'] },
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
		},

		configResolved(config) {
			root = config.root;
			base = config.base || '';
			libDir = path.join(root, 'src', 'lib');
			is_dev = config.command === 'serve';
			is_build = config.command === 'build';
			is_ssr = !!config.build?.ssr;
			sourcemap = !!config.build?.sourcemap;

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
				// Hydrate islands: one emitFile per deduped region id (path+strategy), deterministic
				// filename so SSR can bake `entry` without a client→server hash handoff. csr=false
				// hosts omit wrapper imports so this emit owns the module (avoids Rolldown thin
				// facades from page-graph sharing). N instances → still one entry URL.
				for (const [rid, kind] of region_kinds) {
					if (kind !== 'hydrate') continue;
					const virtualPath = by_id.get(rid);
					if (!virtualPath) continue;
					this.emitFile({
						type: 'chunk',
						id: virtualPath,
						fileName: islandChunkFileName(rid)
					});
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

		configureServer(server) {
			vite_server = server;
		},

		watchChange(id, change) {
			// Unlink often skips handleHotUpdate; drop islands that still import the deleted file.
			if (!is_dev || change.event !== 'delete' || !vite_server) return;
			if (!invalidate_islands_for_file(id, { deleted: true, server: vite_server })) return;
			vite_server.ws.send({ type: 'full-reload', path: '*' });
		},

		handleHotUpdate({ file, server }) {
			if (!is_dev) return;
			vite_server = server;

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
			if (source === V_RUNTIME_URL) return RESOLVED(V_RUNTIME_URL);
			if (source === V_MANIFEST) return RESOLVED(V_MANIFEST);
			if (source === V_RUNTIME) return RESOLVED(V_RUNTIME);
			if (source === V_DEV_HMR) return RESOLVED(V_DEV_HMR);
			if (source === V_DEV_HMR_URL) return RESOLVED(V_DEV_HMR_URL);
			if (source === V_ISLAND_DEPS) return RESOLVED(V_ISLAND_DEPS);
			if (source === V_SECRET) return RESOLVED(V_SECRET);
			if (source === V_SIGN) return RESOLVED(V_SIGN);
			if (source === V_RATE_LIMIT) return RESOLVED(V_RATE_LIMIT);
			if (source === V_SESSION_COOKIE) return RESOLVED(V_SESSION_COOKIE);
			if (source === V_REGION_TTL) return RESOLVED(V_REGION_TTL);
			if (source === V_SERVER_MANIFEST) return RESOLVED(V_SERVER_MANIFEST);
			if (source === V_REQUEST_EVENT) return RESOLVED(V_REQUEST_EVENT);
			if (source === V_REGION_ENDPOINT) return RESOLVED(V_REGION_ENDPOINT);
			// csr=false client hosts rewrite marked bindings here — not a hydrate entry.
			if (source === V_CLIENT_BINDING_STUB) return CLIENT_BINDING_STUB_FILE;
			// CSS-only FOUC graph (no component JS) for csr=false client stubs.
			if (source.startsWith(FOUC_CSS_PREFIX) || source.startsWith(FOUC_SCOPED_PREFIX)) {
				return RESOLVED(source);
			}
			// deep-import Kit's own wire helpers by absolute path (bypasses the exports map)
			if (source === V_KIT_WIRE && kit_wire_path) return kit_wire_path;
			if (source === V_TRANSPORT) return RESOLVED(V_TRANSPORT);

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

			// Portable wrappers import `virtual:ogygia/island/<id>` (and hosts import wrappers).
			// Resolve those BEFORE the "relative to hostPath" branch — that branch uses skipSelf
			// and would bypass this handler, failing to resolve virtual entry ids.
			if (is_island_path(source)) {
				let candidate = source.split('?')[0];
				if (candidate.startsWith('/@id/')) candidate = candidate.slice('/@id/'.length);
				if (candidate.startsWith('/@fs/')) candidate = candidate.slice('/@fs'.length);
				if (registry.has(candidate)) {
					island_graph.add(candidate);
					return candidate;
				}
				const abs = path.isAbsolute(candidate)
					? candidate
					: path.join(root, candidate.replace(LEADING_SLASH, ''));
				if (registry.has(abs)) {
					island_graph.add(abs);
					return abs;
				}
			}

			// Virtual island/wrapper module: resolve relative imports to the host file, and mark
			// the resolved id so its own `$app/*` imports hit the shim branch above.
			// Skip ogygia virtual ids (handled above).
			if (importer_id && registry.has(importer_id) && !is_island_path(source)) {
				const host = registry.get(importer_id).hostPath;
				const resolved = await this.resolve(source, host, { skipSelf: true });
				if (resolved?.id) island_graph.add(strip_id(resolved.id));
				return resolved;
			}
			// Transitive island-graph module (not a virtual entry): mark deps so nested
			// `$app/*` imports stay shimmed. Do NOT resolve island virtual paths via skipSelf.
			if (!ssr && importer_id && island_graph.has(importer_id) && !is_island_path(source)) {
				const resolved = await this.resolve(source, importer, { skipSelf: true });
				if (resolved?.id) island_graph.add(strip_id(resolved.id));
				return resolved;
			}
			return null;
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
			if (id === RESOLVED(V_DEV_HMR)) {
				// Dev-only soft HMR bridge under csr=false (no Kit client entry):
				// join /src/**/*.css into the browser graph + strip Kit's FOUC bag.
				// Failures fall through to a full document reload (see vite:error handler).
				if (!is_dev) return `export {}`;
				return dev_hmr_client_source();
			}
			if (id === RESOLVED(V_DEV_HMR_URL)) {
				// Empty in build/preview; vite-dev URL during `vite dev`. Consumed by wrappers
				// compiled by the app's Vite (not pre-frozen like a package-level import.meta.env).
				if (!is_dev) return `export default '';`;
				return `export default ${JSON.stringify('/@id/__x00__' + V_DEV_HMR)};`;
			}
			if (id === RESOLVED(V_ISLAND_DEPS)) {
				// Client: unused (modulepreload is SSR HTML). SSR: read the handoff JSON at
				// *render* time — Kit builds the server bundle before the client, so baking at
				// `load()` would always be empty; prerender/live SSR run after client generateBundle.
				// Resolve via import.meta.url walk (not absolute build-machine paths) so adapters
				// find `output/server/ogygia-island-deps.json` next to the server bundle.
				if (!ssr) return `export function islandDeps(_entry) { return []; }`;
				return (
					`import fs from 'node:fs';\n` +
					`import path from 'node:path';\n` +
					`import { fileURLToPath } from 'node:url';\n` +
					`let cache;\n` +
					`function candidates() {\n` +
					`  const out = [];\n` +
					`  try {\n` +
					`    let dir = path.dirname(fileURLToPath(import.meta.url));\n` +
					`    for (let i = 0; i < 8; i++) {\n` +
					`      out.push(path.join(dir, 'ogygia-island-deps.json'));\n` +
					`      const parent = path.dirname(dir);\n` +
					`      if (parent === dir) break;\n` +
					`      dir = parent;\n` +
					`    }\n` +
					`  } catch {}\n` +
					`  if (typeof process !== 'undefined' && process.cwd) {\n` +
					`    const cwd = process.cwd();\n` +
					`    out.push(path.join(cwd, '.svelte-kit', 'ogygia-island-deps.json'));\n` +
					`    out.push(path.join(cwd, '.svelte-kit', 'output', 'server', 'ogygia-island-deps.json'));\n` +
					`  }\n` +
					`  return out;\n` +
					`}\n` +
					`function load() {\n` +
					`  if (cache) return cache;\n` +
					`  for (const p of candidates()) {\n` +
					`    try { cache = JSON.parse(fs.readFileSync(p, 'utf8')); return cache; } catch {}\n` +
					`  }\n` +
					`  cache = {};\n` +
					`  return cache;\n` +
					`}\n` +
					`export function islandDeps(entry) {\n` +
					`  if (!entry) return [];\n` +
					`  const list = load()[entry];\n` +
					`  return Array.isArray(list) ? list : [];\n` +
					`}\n`
				);
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
				// SERVER only: signing key. CLIENT build: empty string (never mint in the browser).
				// Runtime prefers `OGYGIA_SECRET` when the host sets it; otherwise the per-build
				// key baked below (same artifact → all instances of this deploy agree).
				if (!ssr) return `export const secret = '';`;
				return `export const secret = process.env.OGYGIA_SECRET || ${JSON.stringify(build_secret)};`;
			}
			if (id === RESOLVED(V_SIGN)) {
				// Same split as secret: SSR mints with node:crypto; client never mints (secret is '').
				if (!ssr) {
					return (
						`export function sign(_secret, _message) { return ''; }\n` +
						`export function verify(_secret, _message, _sig) { return false; }\n` +
						`export function region_mac_message(id, exp, props, session = '') {\n` +
						`  const enc = new TextEncoder();\n` +
						`  const lp = (s) => enc.encode(String(s)).byteLength + ':' + String(s);\n` +
						`  return 'v1|' + lp(id) + '|' + lp(exp) + '|' + lp(props) + '|' + lp(session);\n` +
						`}\n`
					);
				}
				return `export { sign, verify, region_mac_message } from ${JSON.stringify(HMAC_MODULE)};`;
			}
			if (id === RESOLVED(V_REQUEST_EVENT)) {
				// ServerIsland may appear in a transformed page module that Kit's client guard scans.
				// Real getRequestEvent only on SSR; client stub never runs (holes fetch HTML).
				if (!ssr) {
					return `export function getRequestEvent() { throw new Error('ogygia: getRequestEvent is server-only'); }`;
				}
				return `export { getRequestEvent } from '$app/server';`;
			}
			if (id === RESOLVED(V_REGION_ENDPOINT)) {
				// LakeRegion (inside island modules) imports this. SSR mints signed URLs; client
				// returns '' — remount:swr reuses the endpoint cached from the first SSR restore.
				if (!ssr) {
					return `export function makeRegionEndpoint(_entry, _props) { return ''; }`;
				}
				return `export { makeRegionEndpoint } from ${JSON.stringify(REGION_ENDPOINT_MODULE)};`;
			}
			if (id === RESOLVED(V_RATE_LIMIT)) {
				// SERVER only — the region handle is the only consumer.
				if (!ssr) return `export const rateLimit = { max: 0, windowMs: 60000 };`;
				return `export const rateLimit = ${JSON.stringify(rate_limit)};`;
			}
			if (id === RESOLVED(V_SESSION_COOKIE)) {
				// SERVER only — sealed into the region MAC when non-empty.
				if (!ssr) return `export const sessionCookie = '';`;
				return `export const sessionCookie = ${JSON.stringify(session_cookie)};`;
			}
			if (id === RESOLVED(V_REGION_TTL)) {
				// SERVER only — capability expiry window for mint.
				if (!ssr) return `export const regionTtl = 3600;`;
				return `export const regionTtl = ${region_ttl};`;
			}
			if (id === RESOLVED(V_SERVER_MANIFEST)) {
				// Map of SERVER-island id -> dynamic import, used by the `ogygiaHandle()` handle to
				// render an island server-side. Populated in BOTH dev and build (unlike the
				// client manifest, which dev fills from URLs). Client build gets an empty map.
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
				// Legacy stub — hydrate modules are loaded via `<ogygia-region entry>` URLs, not this map.
				return `export const dev = ${is_dev ? 'true' : 'false'};\nexport const regions = {};`;
			}
			const srcEntry = registry.get(id);
			if (srcEntry) {
				let src = srcEntry.source;
				// CLIENT build: rewrite `$app/*` in the GENERATED virtual source to absolute
				// shim paths (defense in depth alongside resolveId island-graph shimming).
				// SSR keeps the real Kit modules (correct server-rendered page.data).
				const ssr = options?.ssr === true;
				if (!ssr) {
					src = src.replace(
						APP_SHIM_IMPORT,
						(_m, _q, name) => JSON.stringify(APP_SHIMS['$app/' + name])
					);
					// LAKES: swap each lake import for the render-nothing placeholder so the lake
					// component's JS is excluded from this island's client chunk. Handles default
					// (`import Lake from '…'`) and named (`import { Lake } from '…'`) forms.
					for (const local of srcEntry.lakes ?? []) {
						src = rewrite_lake_import_to_placeholder(src, local, LAKE_PLACEHOLDER);
					}
				}
				return src;
			}
			return null;
		},

		transform(code, id, options) {
			const ssr = options?.ssr === true;
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
				// Pass Vite's ssr flag through — client csr=false hosts omit wrapper links.
				const result = run_transform(code, id_n, { ssr });
				if (result) {
					register(result, id_n);
					out = result.code;
					map = result.map;
					touched = true;
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

		generateBundle(_options, bundle) {
			// Client only — Kit builds SSR first, so Island.svelte reads this JSON at render
			// (prerender / live SSR), not at SSR-bundle `load()` time.
			if (!is_build || is_ssr) return;
			const map = collectIslandDepModulepreloads(
				bundle as Record<
					string,
					{ type: string; fileName?: string; imports?: string[]; dynamicImports?: string[] }
				>
			);
			const json = JSON.stringify(map);
			const handoff = islandDepsHandoffPath(root);
			fs.mkdirSync(path.dirname(handoff), { recursive: true });
			fs.writeFileSync(handoff, json);
			// Adapter-friendly copy next to the server bundle (Kit SSR out already exists).
			const server_copy = path.join(
				root,
				'.svelte-kit',
				'output',
				'server',
				'ogygia-island-deps.json'
			);
			try {
				fs.mkdirSync(path.dirname(server_copy), { recursive: true });
				fs.writeFileSync(server_copy, json);
			} catch {
				/* ignore — handoff path is enough for prerender */
			}
		}
		},
		{
			name: 'ogygia:island-sourcemaps',
			enforce: 'post',
			transform(code, id) {
				const bare = strip_id(id);
				if (!is_island_path(bare)) return null;
				// After vite-plugin-svelte: maps often list sources as bare `<hash>.svelte`.
				let map: { mappings?: string; sources?: (string | null)[]; [k: string]: unknown };
				try {
					map = this.getCombinedSourcemap();
				} catch {
					return null;
				}
				if (!map?.mappings || !map.sources?.length) return null;
				const sources = rewrite_island_sourcemap_sources(bare, map.sources);
				if (!sources) return null;
				const entry = registry.get(bare);
				const sourcesContent = sources.map((s, i) => {
					const prev = Array.isArray(map.sourcesContent)
						? (map.sourcesContent as (string | null)[])[i]
						: null;
					if (prev != null) return prev;
					if (entry && s === bare) return entry.source;
					return null;
				});
				return {
					code,
					map: { ...map, sources, sourcesContent }
				};
			}
		}
	];
}
