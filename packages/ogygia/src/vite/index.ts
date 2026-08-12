import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { loadEnv, type Plugin } from 'vite';
import type { PreprocessorGroup } from 'svelte/compiler';
import { islandBridge } from './island-bridge.js';
import { content as contentHmrPlugin, type ContentPluginOptions } from '../content/vite/plugin.js';
import { ogygiaPreprocess, type MarkdownOptions } from '../content/markdown/index.js';
import {
	transformHost,
	transformTsRegions,
	ISLAND_DIR,
	normalize_import_keys,
	islandChunkFileName,
	islandPublicUrl,
	wrapperVirtualId,
	CLIENT_BINDING_STUB,
	type ImportKeys
} from '../compiler/transform.js';

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
} from '../compiler/transform.js';
export type { ImportKeys } from '../compiler/transform.js';
import {
	clientBuildWillSkip,
	hasAnyCsrFalseRoute,
	routeCsrIsFalse,
	routeCsrIsTrue,
	KEEP_CLIENT_DIR
} from './standalone.js';
import {
	appendTransportRegistrations,
	appendSvelteModuleRegistrations,
	moduleHasTransportable,
	svelteModuleHasTransportable
} from './transportables.js';
import { generateRuntimeEntrySource, type RuntimeMarks } from './runtime-entry.js';
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
} from '../compiler/fouc-css.js';

/** `packages/ogygia` — Vite must serve absolute shim/runtime resolves from outside the app root. */
const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

const V_RUNTIME_URL = 'virtual:ogygia/runtime-url';
const V_MANIFEST = 'virtual:ogygia/manifest';
const V_RUNTIME = 'virtual:ogygia-runtime';
/** Generated sticky entry — static-imports only the features selected from build marks. */
const V_RUNTIME_ENTRY = 'virtual:ogygia/runtime-entry';
const RUNTIME_ENTRY = V_RUNTIME_ENTRY;
const RUNTIME_DIR = fileURLToPath(new URL('../runtime', import.meta.url));
const V_DEV_HMR = 'virtual:ogygia/dev-hmr';
const V_DEV_HMR_URL = 'virtual:ogygia/dev-hmr-url';
const V_ISLAND_DEPS = 'virtual:ogygia/island-deps';
const V_SECRET = 'virtual:ogygia/secret';
const V_SIGN = 'virtual:ogygia/sign';
const V_RATE_LIMIT = 'virtual:ogygia/rate-limit';
const V_SESSION_COOKIE = 'virtual:ogygia/session-cookie';
const V_REGION_TTL = 'virtual:ogygia/region-ttl';
const V_ROUTER_CONFIG = 'virtual:ogygia/router-config';
const V_SERVER_MANIFEST = 'virtual:ogygia/server-manifest';
const V_REQUEST_EVENT = 'virtual:ogygia/request-event';
const V_REGION_ENDPOINT = 'virtual:ogygia/region-endpoint';
const V_CLIENT_BINDING_STUB = CLIENT_BINDING_STUB;
// Reuse Kit's OWN wire protocol (transport-aware devalue arg/response codec) instead of
// reimplementing it. We deep-import Kit's internal `runtime/shared.js` by absolute path
// (bypassing the exports map) and feed it the app's universal `transport` hook.
const V_KIT_WIRE = 'virtual:ogygia/kit-wire';
const V_TRANSPORT = 'virtual:ogygia/transport';
const V_TRANSPORTABLES = 'virtual:ogygia/transportables';
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
		fileURLToPath(new URL('./runtime-entry.js', import.meta.url)),
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
const RUNTIME_FILENAME = `_app/immutable/ogygia-runtime.${RUNTIME_HASH}.js`;
const RUNTIME_URL_BUILD = '/' + RUNTIME_FILENAME;

const TRAILING_SLASH = /\/$/;
const KIT_REMOTE_CLIENT = /(^|\/)client\.js$/;
const KIT_REMOTE_STATE = /state\.svelte\.js$/;
const LEADING_SLASH = /^\//;
/** Rewrite `$app/{state,stores,navigation}` string literals to absolute shim paths. */
const APP_SHIM_IMPORT = /(['"])\$app\/(state|stores|navigation)\1/g;
const REGEXP_META = /[.*+?^${}()|[\]\\]/g;
const IMPORT_AS_CLAUSE = /^(.+?)(?:\s+as\s+(\w+))?$/;
const BACKSLASH = /\\/g;
const STYLE_EXT = /\.(css|scss|sass|less|styl)(?:$|\?)/i;
const KIT_ROUTE_FILE = /(?:^|\/)\+(?:page|layout|error|server|hooks)(?:\.|$)/;

/**
 * Rewrite a lake binding's import to the render-nothing placeholder (client island modules only).
 * Default imports are repointed; named imports drop that specifier (and keep siblings) then add a
 * default import of the placeholder under the same local name.
 *
 * @internal Used by the plugin client transform and unit tests.
 */
export function rewrite_lake_import_to_placeholder(src: string, local: string, placeholder: string) {
	const esc = local.replace(REGEXP_META, '\\$&');
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
				const m = p.match(IMPORT_AS_CLAUSE);
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
	const norm = file.replace(BACKSLASH, '/');
	if (STYLE_EXT.test(norm)) return false;
	return KIT_ROUTE_FILE.test(norm);
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
	if (STYLE_EXT.test(bare.replace(BACKSLASH, '/'))) return false;
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
		{
			type: string;
			fileName?: string;
			imports?: string[];
			dynamicImports?: string[];
			/** Vite/rolldown-vite chunk metadata — `importedCss` lists the CSS assets a chunk owns. */
			viteMetadata?: { importedCss?: Set<string> | string[] };
		}
	>
): { js: Record<string, string[]>; css: Record<string, string[]> } {
	const js: Record<string, string[]> = {};
	const css: Record<string, string[]> = {};

	const css_of = (fileName: string): string[] => {
		const chunk = bundle[fileName];
		const imported = chunk?.viteMetadata?.importedCss;
		if (!imported) return [];
		return [...imported].map((f) => (f.startsWith('/') ? f : '/' + f));
	};

	const walk = (fileName: string, seen: Set<string>, css_acc: string[]): string[] => {
		const chunk = bundle[fileName];
		if (!chunk || chunk.type !== 'chunk') return [];
		const deps: string[] = [];
		for (const imp of chunk.imports ?? []) {
			if (seen.has(imp)) continue;
			seen.add(imp);
			// Only preload chunks that are actually EMITTED. Rolldown can list a phantom import in a
			// chunk's `imports` (a shared chunk that was merged/tree-shaken away before write) — the
			// real facade never imports it. Baking a modulepreload for a non-existent chunk 404s the
			// prerender. A missing preload only costs a waterfall, so skipping phantoms is safe.
			const dep = bundle[imp];
			if (!dep || dep.type !== 'chunk') continue;
			deps.push(imp.startsWith('/') ? imp : '/' + imp);
			css_acc.push(...css_of(imp));
			deps.push(...walk(imp, seen, css_acc));
		}
		return deps;
	};

	for (const [key, chunk] of Object.entries(bundle)) {
		if (chunk.type !== 'chunk') continue;
		const fileName = chunk.fileName || key;
		if (!ISLAND_FACADE_RE.test(fileName)) continue;
		const entryUrl = fileName.startsWith('/') ? fileName : '/' + fileName;
		const seen = new Set<string>([fileName]);
		// CSS: the facade's own styles + every dep chunk's — this is how a server-picked (held)
		// component's scoped CSS reaches a page that never imported it (the page's stylesheet set
		// can't know; the region response carries these hrefs instead).
		const css_acc = css_of(fileName);
		const raw = walk(fileName, seen, css_acc);
		const uniq: string[] = [];
		const have = new Set<string>([entryUrl]);
		for (const d of raw) {
			if (have.has(d)) continue;
			have.add(d);
			uniq.push(d);
		}
		js[entryUrl] = uniq;
		css[entryUrl] = [...new Set(css_acc)];
	}
	return { js, css };
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
		(bare.startsWith('virtual:ogygia/region/') && bare.endsWith('.js')) ||
		// legacy on-disk path shape (pre-virtual ids); still recognize for resolve/HMR edge cases
		(bare.includes('/' + ISLAND_DIR + '/') && bare.endsWith('.svelte'))
	);
}

/**
 * Named strategy bundle referenced from source via `with { preset: 'name' }`
 * (or the renamed `importKeys.preset` key).
 *
 * A preset speaks the SAME two-dial grammar as an inline import: `render` (the delivery mode) +
 * `wake` (the schedule), plus the tuning options that aren't allowed inline (`margin`, `maxAge`, …).
 */
export interface OgygiaPreset {
	/**
	 * Delivery mode (the `render` import attribute): `'static'` (default — an island that hydrates)
	 * | `'deferred'` (a hole whose HTML is fetched) | `'live'` (a hole that revalidates).
	 */
	render?: 'static' | 'deferred' | 'live';
	/**
	 * Schedule (the `wake` import attribute): hydration when `render` is `'static'`, the FETCH
	 * schedule when `'deferred'`/`'live'`. `'load'` | `'idle'` | `'visible'` | `'interaction'` |
	 * a CSS media query | `'none'` (a frozen lake).
	 */
	wake?: string;
	/** `IntersectionObserver` `rootMargin` when the schedule is `'visible'`. */
	margin?: string;
	/**
	 * `render: 'deferred'` — response cache max-age for the hole's HTML: seconds (number) or a
	 * duration string (`'30s'` | `'5m'` | `'1h'`). Absent or `0` → `no-store`: the hole is dynamic,
	 * re-rendered on every request. A positive value opts into a `private, max-age` browser cache.
	 * Signed into the hole's endpoint so a harvested URL can't be re-pointed at a longer cache.
	 *
	 * With `render: 'live'` this is instead the client revalidate staleness — use a duration string
	 * to stay unit-explicit across both.
	 */
	maxAge?: number | string;
	/** `render: 'live'` — past `maxAge`, whether to clear the hole (`'empty'`) or refetch (`'fetch'`). */
	onExpire?: 'empty' | 'fetch';
	/** `render: 'live'` — the revalidate schedule (`false` disables). Defaults to `wake`. */
	revalidate?: false | string;
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
 *       presets: { chart: { wake: 'visible', margin: '200px' } },
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
	 * Client-side SPA router — app-wide, on by default. It intercepts same-origin links, swaps
	 * `<body>`, merges `<head>`, and keeps `data-ogygia-keep` chrome across navigations. No component
	 * to place: the server handle injects the runtime + the `ogygia-router` meta into every page.
	 *
	 * - `true` (default) — router on, View Transitions on.
	 * - `false` — router off (the whole feature is tree-shaken out; same-origin links do full MPA loads).
	 * - `{ viewTransitions: false }` — router on, but no View Transitions API on navigation.
	 *
	 * Per-page escape hatch (no second config): a page opts *itself* out of View Transitions by
	 * emitting `<svelte:head><meta name="ogygia-router" content="plain" /></svelte:head>` — the handle
	 * injects the app default but a page that sets its own meta wins.
	 */
	router?: boolean | { viewTransitions?: boolean };

	/**
	 * Content-collection config. `markdown` configures the mdsvex preprocessor (themes, remark
	 * plugins, heading ids…) so all config lives in one place — the svelte config then references a
	 * value-free `markdown()`. The rest are dev HMR options. Only relevant when you use content.
	 */
	content?: ContentPluginOptions & { markdown?: MarkdownOptions };

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
	 * CONTINUITY — the app forgets less across navigation.
	 * - `forms` (default `true`): an island's half-filled form fields survive SPA navigation and
	 *   back/forward within the tab session. Restored on return, with `bind:` synced. Set `false`
	 *   to disable.
	 * - `speculate` (default off): emit native Speculation Rules so the browser prerenders likely
	 *   next pages. `'hover'` (moderate eagerness) or `'viewport'` (eager). PPR shells make this
	 *   nearly free. Same-origin only; use only when GET navigations are side-effect-free.
	 */
	continuity?: {
		forms?: boolean;
		speculate?: 'hover' | 'viewport' | false;
	};

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

	// Publish the markdown config so a value-free `markdown()` in the svelte config reads it — all
	// content/markdown config stays here in the one plugin. `standalone` re-invokes this factory for
	// its throwaway client build; don't let that clobber the real config with `null`.
	if (!standalone && options.content?.markdown) {
		islandBridge.markdownConfig = options.content.markdown as Record<string, unknown>;
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

	// CONTINUITY config. Ambient island-form survival across SPA nav is ON by default; speculation
	// rules (native prerender of likely-next pages) are opt-in ('hover' | 'viewport').
	const continuity_forms = options.continuity?.forms !== false;
	const continuity_speculate: 'hover' | 'viewport' | false =
		options.continuity?.speculate === 'hover' || options.continuity?.speculate === 'viewport'
			? options.continuity.speculate
			: false;

	/** Build-time capability marks for the sticky runtime entry. Incomplete → kitchen-sink. */
	const runtime_marks: RuntimeMarks = {
		complete: false,
		speculate: continuity_speculate === false ? false : continuity_speculate,
		forms: continuity_forms,
		wire: true,
		remoteSeeds: true,
		hydrate: [],
		defer: [],
		persistKeys: [],
		// Router is app-wide config now (not detected from a `<Router/>` usage): the feature ships
		// whenever `router` isn't `false`.
		router: router_enabled,
		live: false,
		lakes: false
	};

	const note_runtime_mark = (patch: Partial<RuntimeMarks>) => {
		if (patch.hydrate) {
			runtime_marks.hydrate = [...new Set([...(runtime_marks.hydrate || []), ...patch.hydrate])];
		}
		if (patch.defer) {
			runtime_marks.defer = [...new Set([...(runtime_marks.defer || []), ...patch.defer])];
		}
		if (patch.persistKeys) {
			runtime_marks.persistKeys = [
				...new Set([...(runtime_marks.persistKeys || []), ...patch.persistKeys])
			];
		}
		if (patch.router) runtime_marks.router = true;
		if (patch.live) runtime_marks.live = true;
		if (patch.persist) runtime_marks.persist = true;
		if (patch.morph) runtime_marks.morph = true;
		if (patch.lakes) runtime_marks.lakes = true;
	};

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
	let content_scanned = false;
	/** Absolute paths of app modules that define a transportable class (built during prescan). */
	const transportable_modules = new Set();
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

	const virtualPathFor = (_hostId, iid) => islandVirtualId(iid);

	/** Dev URL for dynamic `import(entry)` of a virtual island module. */
	const devUrlFor = (virtualPath) => {
		const prefix = base && base !== '/' ? base.replace(TRAILING_SLASH, '') : '';
		return prefix + '/@id/' + virtualPath;
	};

	const transform_cache = new Map();

	const host_key = (hostPath) => path.resolve(strip_id(hostPath));

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
		// NB: do NOT clear transform_cache here. `register()` calls this on every leg AFTER
		// run_transform populated the cache, so clearing evicted the just-written entry (the cache
		// never hit → every host re-parsed 3× + an O(n) scan per call). The cache is content-keyed
		// (`hit.code === source`), so a changed source misses and recomputes on its own; a deleted
		// file's stale entry is harmless (never queried again). HMR correctness is preserved.
	};

	const run_transform = (source, id, opts: { ssr?: boolean; linkVirtual?: boolean } = {}) => {
		const ssr = opts.ssr !== false;
		// Scale: csr=false CLIENT hosts must not statically import portable wrappers (or the
		// hydrate entries those wrappers pull in). Kit still emits those page nodes; sharing
		// the emitFile module with the page graph forces Rolldown thin `ogygia-island.*`
		// facades. SSR keeps real wrappers for HTML; csr=true client keeps them so Kit can
		// hydrate islands as normal components. Hydration always uses `import(entry)`.
		const routesDir = path.join(root, 'src', 'routes');
		const link_virtual =
			opts.linkVirtual !== undefined ? opts.linkVirtual : ssr || !routeCsrIsFalse(id, routesDir);
		// csr=true route host → ogygia steps aside (no island, no runtime). Route-scoped: a shared lib
		// component keeps its islands (its csr depends on the page). See transformHost's csrTrue branch.
		const csr_true = routeCsrIsTrue(id, routesDir);
		const cache_key = `${id}\0${link_virtual ? '1' : '0'}\0${csr_true ? 't' : 'f'}`;
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
			clientBindingStub: V_CLIENT_BINDING_STUB,
			csrTrue: csr_true
		});
		transform_cache.set(cache_key, { code: source, result });
		return result;
	};

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
	const keep_client_dir = (r) => path.join(r, 'src', 'routes', KEEP_CLIENT_DIR);

	const inject_keep_client_route = (r) => {
		const dir = keep_client_dir(r);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, '+layout.ts'),
			'// Generated by ogygia for the duration of the build, then removed. A layout-only node —\n' +
				'// no +page, so no servable URL — that stops SvelteKit skipping its client build when every\n' +
				'// real route is csr = false. Safe to delete (gitignored; ogygia self-heals it).\n' +
				'export const csr = true;\n'
		);
	};

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
			const kind = isl.kind ?? (isl.server ? 'defer' : 'hydrate');
			// Record the ACTUAL wake schedule (so `interaction` is detected) + the deferred fetch
			// timing (so streaming is only pulled for `render: 'deferred'` load holes).
			if (kind === 'defer') note_runtime_mark({ defer: [isl.fetchWhen || 'load'] });
			if (kind === 'hydrate') note_runtime_mark({ hydrate: [isl.strategy || 'load'] });
			if (isl.wakeAfter) note_runtime_mark({ hydrate: [isl.wakeAfter] });
			if (kind === 'lake') note_runtime_mark({ lakes: true, hydrate: ['none'] });
			// live + client-morph are needed by HELD regions (region() / region:'raw' / live content),
			// which stream and re-render on the client — NOT by a plain `wake`-marked placed island,
			// which merely hydrates once. Every wake import now has a `bindingPath` (attach-to-binding
			// unification), so gating on that over-shipped live+morph to minimal apps; gate on `held`.
			if (isl.held) note_runtime_mark({ live: true, morph: true });
			if (isl.lakes?.length) note_runtime_mark({ lakes: true });
			if (isl.keep) note_runtime_mark({ persist: true, persistKeys: [isl.keep] });
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
			// Region binding: the host imports this JS module; its source is leg-split at load()
			// (SSR carries the signer, client is metadata-only). Not a svelte wrapper.
			if (isl.bindingPath && isl.bindingSsrSource) {
				registry.set(isl.bindingPath, {
					ssrSource: isl.bindingSsrSource,
					clientSource: isl.bindingClientSource ?? isl.bindingSsrSource,
					hostPath: isl.hostPath,
					id: isl.id,
					server: false,
					lakes: [],
					componentPath: isl.componentPath ?? null,
					role: 'region'
				});
				idx.vpaths.add(isl.bindingPath);
				island_graph.add(isl.bindingPath);
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

	// Preprocessor bridge: `.svx` / `.md` islands are rewritten by a preprocessor (composed into
	// `markdown()`) that runs AFTER mdsvex, then handed back to this plugin's registry. Wrapper-always
	// (linkVirtual: true) because a preprocessor output is shared across the ssr/client legs and can't
	// make the csr=false stub split; content files aren't routes, so they'd get wrappers anyway.
	islandBridge.transform = (source, filename) => {
		const result = run_transform(source, filename, { ssr: false, linkVirtual: true });
		if (!result || !result.islands?.length) return null;
		register(result, filename);
		return result.code;
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
					// A `<script module>` transportable class goes in the manifest too (keyed by the
					// .svelte path — side-effect-importing the component runs its module registration).
					if (svelteModuleHasTransportable(src, full)) transportable_modules.add(full);
					const result = run_transform(src, full);
					if (result) register(result, full);
				} else if (
					(entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) &&
					!entry.name.endsWith('.d.ts')
				) {
					// `.ts` / `.js` region mints (load / remote functions). Discover them up front so a
					// deferred region's server-manifest entry exists before the endpoint is ever hit —
					// lazy transform order would otherwise leave the id missing (403 on first fetch).
					const src = readFile(full);
					if (src == null) continue;
					// Transportable classes go into the eager-registration manifest so an island
					// receiving one as a prop never has to import the class itself.
					if (moduleHasTransportable(src, full)) transportable_modules.add(full);
					const result = transformTsRegions(src, full, {
						root,
						libDir,
						pathModule: path,
						dev: is_dev,
						virtualPathFor,
						devUrlFor,
						importKeys: import_keys,
						idSalt: id_salt
					});
					if (result) register(result, full);
				}
			}
		};
		walk(src_dir);
		// prescan walked every host — the capability marks are now COMPLETE, so the generated sticky
		// runtime entry can bundle only the features this app uses (else it stays kitchen-sink).
		runtime_marks.complete = true;
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
					// `server.fs.allow`: kit-remote stubs / runtime resolve to absolute paths under this
					// package; without it Vite 403s them when the app root is docs/ or playground/.
					return {
						ssr: { noExternal: ['esm-env'] },
						// CONTINUITY config → compile-time constants the client runtime reads (typeof-guarded,
						// so a plain node import of dist/ without these defined falls back to defaults).
						define: {
							__OGYGIA_CONTINUITY_FORMS__: JSON.stringify(continuity_forms),
							__OGYGIA_CONTINUITY_SPECULATE__: JSON.stringify(continuity_speculate)
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
			libDir = path.join(root, 'src', 'lib');
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
		},

		async buildStart() {
			// CLIENT build (Kit-driven): emit the runtime chunk. Kit builds the SERVER bundle FIRST,
			// then the client, so the server can't learn a hash the LATER client build produces — a
			// forward handoff is impossible. Instead the filename is a deterministic SOURCE-content
			// hash (RUNTIME_FILENAME, computed at module load from the prebuilt dist inputs), so the
			// server (baking the `<script src>`) and the client (emitting this chunk) compute the
			// SAME name independently and agree. (Standalone mode further overrides with the real
			// output-chunk hash below.)
			// Discover islands up front — in BOTH the SSR and client legs. The client build needs them
			// to emit chunks; the SSR build needs them for the server manifest. Kit builds SSR FIRST,
			// so if we only scanned in the client leg the SSR manifest would miss `.svx`/`.md` SERVER
			// islands (defer / deferred regions) and their signed endpoint would 403. `prescan` reads
			// `.svelte`/`.ts`; `islandBridge.scan` (set by a preprocessor package like ogygia/content)
			// contributes islands from markdown, which becomes Svelte only after that preprocessor.
			if (is_build && !content_scanned) {
				content_scanned = true;
				prescan();
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
						fileName: RUNTIME_FILENAME
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
					this.emitFile({
						type: 'chunk',
						id: virtualPath,
						fileName: islandChunkFileName(rid)
					});
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
			if (source === V_RUNTIME_ENTRY) return RESOLVED(V_RUNTIME_ENTRY);
			if (source === V_DEV_HMR) return RESOLVED(V_DEV_HMR);
			if (source === V_DEV_HMR_URL) return RESOLVED(V_DEV_HMR_URL);
			if (source === V_ISLAND_DEPS) return RESOLVED(V_ISLAND_DEPS);
			if (source === V_SECRET) return RESOLVED(V_SECRET);
			if (source === V_SIGN) return RESOLVED(V_SIGN);
			if (source === V_RATE_LIMIT) return RESOLVED(V_RATE_LIMIT);
			if (source === V_ROUTER_CONFIG) return RESOLVED(V_ROUTER_CONFIG);
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
			if (source === V_TRANSPORTABLES) return RESOLVED(V_TRANSPORTABLES);

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
			if (id === RESOLVED(V_RUNTIME_ENTRY)) {
				// Ensure every host was walked (marks complete) before selecting features.
				if (!scanned) prescan();
				const { code } = generateRuntimeEntrySource(runtime_marks, RUNTIME_DIR);
				return code;
			}
			if (id === RESOLVED(V_RUNTIME)) {
				// Dev sticky: kitchen-sink package entry. Build uses the hashed emitFile chunk.
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
				if (!ssr)
					return `export function islandDeps(_entry) { return []; }\nexport function islandCss(_entry) { return []; }`;
				// DEV: there is no built CSS asset to link (Vite serves component CSS only as importable
				// modules). The `entry` a region carries IS its dev module URL (moduleUrl / dev island_url),
				// so returning it lets the client `import()` it for its CSS side-effect — the same region-css
				// channel as prod's `<link>`, resolved for dev. `islandDeps` (JS modulepreload) is prod-only.
				if (is_dev)
					return `export function islandDeps(_entry) { return []; }\nexport function islandCss(entry) { return entry ? [entry] : []; }`;
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
					// Handoff shape: `{ js: { entryUrl: [...] }, css: { entryUrl: [...] } }`. A stale flat
					`// map (pre-css build) degrades gracefully: js falls back to the root, css to [].\n` +
					`function pick(kind, entry) {\n` +
					`  const all = load();\n` +
					`  const map = all && typeof all[kind] === 'object' ? all[kind] : kind === 'js' ? all : null;\n` +
					`  const list = map ? map[entry] : null;\n` +
					`  return Array.isArray(list) ? list : [];\n` +
					`}\n` +
					`export function islandDeps(entry) {\n` +
					`  return entry ? pick('js', entry) : [];\n` +
					`}\n` +
					`export function islandCss(entry) {\n` +
					`  return entry ? pick('css', entry) : [];\n` +
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
				if (!ssr) return `export const secret = '';\nexport const secretStable = false;`;
				// `secretStable`: whether the key survives redeploys (env-provided vs per-build random).
				// Prerender uses it to warn when minting ~forever capabilities a redeploy would orphan.
				return (
					`export const secret = process.env.OGYGIA_SECRET || ${JSON.stringify(build_secret)};\n` +
					`export const secretStable = !!process.env.OGYGIA_SECRET;`
				);
			}
			if (id === RESOLVED(V_SIGN)) {
				// Same split as secret: SSR mints with node:crypto; client never mints (secret is '').
				if (!ssr) {
					return (
						`export function sign(_secret, _message) { return ''; }\n` +
						`export function verify(_secret, _message, _sig) { return false; }\n` +
						`export function region_mac_message(id, exp, props, session = '', ttl = '') {\n` +
						`  const enc = new TextEncoder();\n` +
						`  const lp = (s) => enc.encode(String(s)).byteLength + ':' + String(s);\n` +
						`  return 'v1|' + lp(id) + '|' + lp(exp) + '|' + lp(props) + '|' + lp(session) + '|' + lp(ttl);\n` +
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
				// Region.svelte imports this for its lake (`makeRegionEndpoint`, swr) and server-island
				// (`mintServerIsland`) branches. SSR mints signed URLs; client returns '' — lakes reuse the
				// endpoint cached from the first SSR restore, and server islands never mint on the client
				// (the runtime fetches the endpoint). Routing minting through this client-stubbed virtual is
				// what lets one `Region` live in the main `ogygia` graph without leaking `$app/server`.
				if (!ssr) {
					return (
						`export function makeRegionEndpoint(_entry, _props) { return ''; }\n` +
						`export function mintServerIsland(_entry, _props, _ttl) { return ''; }`
					);
				}
				return `export { makeRegionEndpoint, mintServerIsland } from ${JSON.stringify(REGION_ENDPOINT_MODULE)};`;
			}
			if (id === RESOLVED(V_RATE_LIMIT)) {
				// SERVER only — the region handle is the only consumer.
				if (!ssr) return `export const rateLimit = { max: 0, windowMs: 60000 };`;
				return `export const rateLimit = ${JSON.stringify(rate_limit)};`;
			}
			if (id === RESOLVED(V_ROUTER_CONFIG)) {
				// The handle reads this to inject the runtime + `ogygia-router` meta into every page head
				// (app-wide SPA router). Just two booleans; safe on either leg.
				return (
					`export const enabled = ${router_enabled};\n` +
					`export const viewTransitions = ${router_view_transitions};`
				);
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
				if (!ssr) return `export const islands = {};\nexport const island_url = {};`;
				prescan();
				const entries = [];
				const urls = [];
				for (const [iid, virtualPath] of by_id) {
					if (!registry.get(virtualPath)?.server) continue;
					entries.push(`  ${JSON.stringify(iid)}: () => import(${JSON.stringify(virtualPath)})`);
					// id → the URL `islandCss()` is keyed by, so the handle can ship a server-picked hole's
					// CSS with its response (a page that never imported the component still styles it). In a
					// build that's the hashed client chunk (→ handoff CSS assets); in dev it's the entry's
					// dev module URL (→ `islandCss` returns it, the client imports it for CSS). Same channel.
					urls.push(
						`  ${JSON.stringify(iid)}: ${JSON.stringify(is_dev ? devUrlFor(virtualPath) : islandPublicUrl(iid))}`
					);
				}
				return (
					`export const islands = {\n${entries.join(',\n')}\n};\n` +
					`export const island_url = {\n${urls.join(',\n')}\n};`
				);
			}
			if (id === RESOLVED(V_MANIFEST)) {
				// Legacy stub — hydrate modules are loaded via `<ogygia-region entry>` URLs, not this map.
				return `export const dev = ${is_dev ? 'true' : 'false'};\nexport const regions = {};`;
			}
			if (id === RESOLVED(V_TRANSPORTABLES)) {
				// Eager-registration manifest: side-effect-import every module that defines a
				// transportable class so their `[ogygia.wire]` codecs register before any island
				// decodes props. Imported by every island entry (client hydrate AND server render),
				// so an island receiving a transportable prop never has to import the class itself.
				// Empty (a no-op, tree-shaken) when the app has no transportables.
				prescan();
				const imports = [];
				for (const abs of transportable_modules) imports.push(`import ${JSON.stringify(abs)};`);
				return imports.join('\n') + '\n';
			}
			const srcEntry = registry.get(id);
			if (srcEntry && srcEntry.role === 'region') {
				// Leg-split: SSR gets the signer-carrying descriptor, client gets metadata only.
				return options?.ssr === true ? srcEntry.ssrSource : srcEntry.clientSource;
			}
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
						src = rewrite_lake_import_to_placeholder(src, local, CLIENT_BINDING_STUB_FILE);
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
				const result = transformTsRegions(out, id_n, {
					root,
					libDir,
					pathModule: path,
					dev: is_dev,
					virtualPathFor,
					devUrlFor,
					importKeys: import_keys,
					idSalt: id_salt
				});
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

		writeBundle(_options, bundle) {
			// Client only — Kit builds SSR first, so Region.svelte reads this JSON at render
			// (prerender / live SSR), not at SSR-bundle `load()` time.
			//
			// `writeBundle` (not `generateBundle`): rolldown merges/eliminates shared chunks AFTER
			// `generateBundle`, so a chunk's `imports` there can name a phantom that's gone by write.
			// By `writeBundle` the bundle reflects the files actually on disk.
			if (!is_build || is_ssr) return;
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
				// A generated WRAPPER virtual (`virtual:ogygia/wrapper/<hash>.svelte`) is glue with no source
				// on disk. vite-plugin-svelte emits a map whose `sources` is the bare `<hash>.svelte` basename
				// with no `sourcesContent`; Vite then disk-probes it and warns "points to missing source files"
				// — once per island, on every dev page. Rewriting the sources to the virtual id does NOT stick
				// (Vite's `combineSourcemaps` re-traces to svelte's basename map) and inlining `sourcesContent`
				// is lost the same way — so we drop the map for wrappers: Vite skips `injectSourcesContent` when
				// `mappings` is empty, and a wrapper is generated code no one steps through.
				if (bare.includes('/wrapper/')) return { code, map: { mappings: '' } };
				// Other island svelte virtuals (if any): rewrite basename `<hash>.svelte` sources to the full
				// virtual id and inline the generated source as `sourcesContent`.
				let map: {
					version: number;
					mappings: string;
					names: string[];
					sources: (string | null)[];
					sourcesContent?: (string | null)[];
					file?: string;
				};
				try {
					map = this.getCombinedSourcemap();
				} catch {
					return null;
				}
				if (!map?.mappings || !map.sources?.length) return null;
				const rewritten = rewrite_island_sourcemap_sources(bare, map.sources);
				const sources = rewritten ?? map.sources;
				const entry = registry.get(bare);
				const base_name = bare.slice(bare.lastIndexOf('/') + 1);
				let injected = false;
				const sourcesContent = sources.map((s, i) => {
					const prev = Array.isArray(map.sourcesContent)
						? (map.sourcesContent as (string | null)[])[i]
						: null;
					if (prev != null) return prev;
					if (entry && (s === bare || s === base_name)) {
						injected = true;
						return entry.source;
					}
					return null;
				});
				if (!rewritten && !injected) return null;
				return {
					code,
					map: { ...map, sources, sourcesContent }
				};
			}
		}
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
	islandBridge.markdownConfig ? [ogygiaPreprocess()] : [];

/**
 * The full svelte `extensions` list — pass it straight through: `extensions: ogygia.extensions()`.
 * Always includes `.svelte`; adds `.svx` / `.md` when `ogygia({ content: { markdown } })` is set.
 */
ogygia.extensions = (): string[] =>
	islandBridge.markdownConfig ? ['.svelte', '.svx', '.md'] : ['.svelte'];
