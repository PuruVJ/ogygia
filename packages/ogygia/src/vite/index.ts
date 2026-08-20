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
import { rewrite_wire } from '../compiler/macros/wire.js';
import { rewrite_dollar } from '../compiler/macros/dollar.js';
import { rewrite_store, auto_brand_stores } from '../compiler/macros/store.js';
import { rewrite_regions } from '../compiler/content/regions.js';
import { rewrite_code } from '../compiler/macros/code.js';
import { render_snippet } from '../content/markdown/snippet.js';
import { render_markdown } from '../content/markdown/render-md.js';
import { rewrite_bake } from '../compiler/macros/bake.js';

/** Markup extensions where `import.meta.og.*` constructs are recognized at the VITE-transform layer.
 *  Just `.svelte` — content files (`.svx`/`.md`) are the markdown preprocessor's domain (see
 *  og-extract.ts). JS/TS modules are handled by the constructs themselves, not this list. */
const CONSTRUCT_MARKUP_EXTS = ['.svelte'] as const;
import { content as contentHmrPlugin, type ContentPluginOptions } from '../content/vite/plugin.js';
import { ogygiaPresetPreprocess, type MarkdownOptions } from '../content/markdown/index.js';
import {
	transformTsRegions,
	ISLAND_DIR,
	normalize_import_keys,
	islandChunkFileName,
	CLIENT_BINDING_STUB,
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
export type { ImportKeys } from '../compiler/region/transform.js';
import {
	clientBuildWillSkip,
	hasAnyCsrFalseRoute,
	KEEP_CLIENT_DIR
} from '../compiler/standalone.js';
import {
	appendTransportRegistrations,
	appendSvelteModuleRegistrations,
	moduleHasTransportable,
	svelteModuleHasTransportable
} from '../compiler/content/transportables.js';
import { generateRuntimeEntrySource, resolveFeatures, type RuntimeMarks } from '../compiler/link/runtime-entry.js';
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
	isFoucScopedId,
	resolveFoucImportSpec
} from '../compiler/fouc-css.js';
import {
	needs_csr_false_full_reload,
	needs_island_entry_full_reload,
	same_module_path,
	island_vpaths_affected_by_file
} from '../compiler/dev/hmr.js';
import { dev_hmr_client_source } from '../compiler/dev/dev-hmr.js';
import { derive_css_scope_owners, type DevGraphModule } from '../compiler/dev/css-scope.js';
import {
	collectIslandDepModulepreloads,
	islandDepsHandoffPath,
	island_deps_module
} from '../compiler/link/island-deps.js';
import {
	secret_module,
	sign_module,
	rate_limit_module,
	session_cookie_module,
	region_ttl_module
} from '../compiler/link/caps.js';
import { router_config_module } from '../compiler/link/router-config.js';
import { transport_module, transportables_module } from '../compiler/link/transport.js';
import { server_manifest_module } from '../compiler/link/server-manifest.js';
import { manifest_module } from '../compiler/link/manifest.js';
import { Program, strip_id, host_key } from '../compiler/program.js';
import { Compiler } from '../compiler/driver.js';
import { CompileCtx } from '../compiler/ctx.js';
import {
	V_RUNTIME_URL,
	V_MANIFEST,
	V_RUNTIME,
	V_RUNTIME_ENTRY,
	V_DEV_HMR,
	V_DEV_HMR_URL,
	V_ISLAND_DEPS,
	V_FN_MANIFEST,
	V_SECRET,
	V_SIGN,
	V_RATE_LIMIT,
	V_SESSION_COOKIE,
	V_REGION_TTL,
	V_ROUTER_CONFIG,
	V_SERVER_MANIFEST,
	V_REQUEST_EVENT,
	V_REGION_ENDPOINT,
	V_KIT_WIRE,
	V_TRANSPORT,
	V_TRANSPORTABLES,
	RESOLVED,
	islandVirtualId
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

const RUNTIME_ENTRY = V_RUNTIME_ENTRY;
const RUNTIME_DIR = fileURLToPath(new URL('../runtime', import.meta.url));
const V_CLIENT_BINDING_STUB = CLIENT_BINDING_STUB;

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
// The runtime chunk is FEATURE-SELECTED — `generateRuntimeEntrySource` emits DIFFERENT bytes per the
// app's resolved marks (router / live / lakes / wire / …). So the `_app/immutable/…` filename (served
// `immutable, 1yr`) must bust when the FEATURE SET changes, not only when ogygia's source does — else
// the same ogygia version, after an app adds e.g. a `live` region, reuses the cached old runtime and
// that feature silently never boots for returning visitors. `runtime_feature_hash` is filled after
// prescan; BOTH build legs run the same deterministic prescan → same features → same name, so the
// server↔client filename handoff still holds. Empty until prescan (dev serves the package entry).
let runtime_feature_hash = '';
const runtime_chunk_filename = () =>
	`_app/immutable/og-runtime.${RUNTIME_HASH}${runtime_feature_hash ? '-' + runtime_feature_hash : ''}.js`;
const runtime_chunk_url = () => '/' + runtime_chunk_filename();

const TRAILING_SLASH = /\/$/;
const KIT_REMOTE_CLIENT = /(^|\/)client\.js$/;
const KIT_REMOTE_STATE = /state\.svelte\.js$/;
const LEADING_SLASH = /^\//;
/** Rewrite `$app/{state,stores,navigation}` string literals to absolute shim paths. */
const APP_SHIM_IMPORT = /(['"])\$app\/(state|stores|navigation)\1/g;
const REGEXP_META = /[.*+?^${}()|[\]\\]/g;
const IMPORT_AS_CLAUSE = /^(.+?)(?:\s+as\s+(\w+))?$/;

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

/** css-ish file the dev bridge manages (mirrors the bridge's glob). */
const DEV_CSS_FILE_RE = /\.(css|scss|sass|less|styl)$/;

/** A `?…type=style…` / `lang.css` sub-import id — a CSS face, never a corpus JS leak. */
const CONTENT_STYLE_QUERY_RE = /[?&](?:type=style|lang\.css)/;

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
	/** Continuity name (the `keep` import attribute): the live island relocates across SPA
	 *  navigation instead of remounting when the next page carries the same name. */
	keep?: string;
}

/** Per-IP budget for the signed deferred-region / lake-remount endpoint. */
export interface OgygiaRateLimit {
	/** Max requests per window (default `60`). `0` disables allowing any. */
	max?: number;
	/** Sliding window length in milliseconds (default `60_000`). */
	windowMs?: number;
}

/**
 * The `regions` subsystem — island defaults + the named preset dictionary. One grammar shared by
 * every subsystem: defaults at the root, variance in `presets`, referenced from a use site by a
 * LITERAL `preset: 'name'` (here: `import X from '…' with { preset: 'name' }`).
 */
export interface RegionsOptions {
	/**
	 * Global defaults for islands that use `wake: 'visible'` / `render`+`wake: 'visible'`
	 * without their own `margin` (via a preset).
	 */
	visible?: {
		/** Default `IntersectionObserver` `rootMargin` (e.g. `'200px'`). */
		margin?: string;
	};
	/**
	 * Named strategy bundles. Reference one from an import:
	 * `import Chart from '$lib/Chart.svelte' with { preset: 'chart' };`
	 */
	presets?: Record<string, OgygiaPreset>;
}

/**
 * A named CONTENT preset — a partial content-config referenced by a literal `preset: 'name'` on a
 * loader macro (`import.meta.og.loader.folder('../docs', { preset: 'name' })`). The referencing
 * collection's files compile as their own module VARIANTS (`?og_preset=name`), so the same file
 * used by another collection under another preset renders independently — never a conflict.
 */
export interface ContentPreset {
	/** Markdown options merged over `content.markdown` (per setting key — depth-2 replace). */
	markdown?: MarkdownOptions;
}

/**
 * Options for the {@link ogygia} Vite plugin — one top-level key per subsystem, each subsystem
 * `defaults + its own presets`.
 *
 * @example
 * ```ts
 * import { ogygia } from 'ogygia/vite';
 * export default defineConfig({
 *   plugins: [
 *     ogygia({
 *       regions: {
 *         visible: { margin: '200px' },
 *         presets: { chart: { wake: 'visible', margin: '200px' } }
 *       },
 *       regionTtl: 3600
 *     }),
 *     sveltekit()
 *   ]
 * });
 * ```
 */
export interface OgygiaOptions {
	/** The regions subsystem: island defaults (`visible.margin`) + named island presets. */
	regions?: RegionsOptions;

	/**
	 * Client-side SPA router — app-wide, on by default. It intercepts same-origin links, swaps
	 * `<body>`, merges `<head>`, and keeps `data-ogygia-keep` chrome across navigations. No component
	 * to place: the server handle injects the runtime + the `ogygia-router` meta into every page.
	 *
	 * - `true` (default) — router on, View Transitions on, form continuity on.
	 * - `false` — router off (the whole feature is tree-shaken out; same-origin links do full MPA
	 *   loads, and form continuity — which rides SPA navigation — goes with it).
	 * - `{ viewTransitions: false }` — router on, but no View Transitions API on navigation.
	 * - `{ forms: false }` — router on, but an island's half-filled form fields are NOT carried
	 *   across SPA navigation (continuity off).
	 * - `{ serverDelta: true }` — opt IN to server-delta nav: an SPA nav tells the server (via an
	 *   `x-ogygia-known` header) which islands it already has live, so the server SKIPS re-rendering
	 *   the unchanged ones and the client keeps them running. OFF by default (it is a new client↔server
	 *   protocol); when off the client never sends the header and the server always full-renders.
	 *
	 * Per-page escape hatch (no second config): a page opts *itself* out of View Transitions by
	 * emitting `<svelte:head><meta name="ogygia-router" content="plain" /></svelte:head>` — the handle
	 * injects the app default but a page that sets its own meta wins.
	 */
	router?: boolean | { viewTransitions?: boolean; forms?: boolean; serverDelta?: boolean };

	/**
	 * The content subsystem. `markdown` configures the mdsvex preprocessor (themes, remark plugins,
	 * heading ids…) — the defaults for every markdown file. `presets` are named variants a loader
	 * macro opts a whole collection into (`{ preset: 'name' }`); requires `markdown` to be set (the
	 * defaults are the base every preset merges over). The rest are dev HMR options.
	 */
	content?: ContentPluginOptions & { markdown?: MarkdownOptions; presets?: Record<string, ContentPreset> };

	/**
	 * Rename the import-attribute keys claimed by the transform.
	 * Defaults stay `hydrate` / `defer` / `preset`. Escape hatch if another tool already
	 * uses those names on the same imports.
	 *
	 * Preset **definitions** ({@link RegionsOptions.presets}) still use canonical `hydrate` /
	 * `defer` / `margin` / `remount` — only the `with { … }` spellings in source change.
	 */
	importKeys?: Partial<ImportKeys>;

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
 * The pre-v3 option spellings, killed by the config-surface collapse. Detected at config load and
 * answered with the exact new spelling — a rename map, never silent aliasing (a legacy key that
 * silently did nothing would un-tune real apps).
 */
const LEGACY_OPTION_RENAMES: Record<string, string> = {
	visible: "`visible` moved into the regions subsystem — write `regions: { visible: { … } }`.",
	presets: "`presets` moved into the regions subsystem — write `regions: { presets: { … } }`.",
	continuity:
		"`continuity` is gone — form continuity rides the router. Write `router: { forms: false }` to disable it."
};

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

	// The v3 rename map: a legacy key errors with its new spelling, never silently no-ops.
	for (const key of Object.keys(LEGACY_OPTION_RENAMES)) {
		if (key in (options as Record<string, unknown>)) {
			throw new Error(`[ogygia] ${LEGACY_OPTION_RENAMES[key]}`);
		}
	}

	const visibleMargin = options.regions?.visible?.margin;
	const presets = options.regions?.presets || {};
	// Config-time preset validation — the transform re-checks on USE (with file/line context), but a
	// broken preset nobody references yet should still fail the build, not lurk.
	const REGION_PRESET_KEYS = new Set(['render', 'wake', 'margin', 'maxAge', 'onExpire', 'revalidate', 'keep']);
	for (const [name, bag] of Object.entries(presets)) {
		if (!bag || typeof bag !== 'object' || Object.keys(bag).length === 0) {
			throw new Error(`[ogygia] regions.presets.${name} is empty — a preset with nothing is a mistake.`);
		}
		for (const k of Object.keys(bag)) {
			if (!REGION_PRESET_KEYS.has(k)) {
				throw new Error(
					`[ogygia] regions.presets.${name}: unknown key \`${k}\`. A regions preset takes ${[...REGION_PRESET_KEYS].join(', ')}.`
				);
			}
		}
	}
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
		const content_presets = options.content.presets;
		if (!options.content.markdown) {
			throw new Error(
				'[ogygia] content.presets requires content.markdown — the defaults are the base every preset merges over (an empty `markdown: {}` is fine).'
			);
		}
		for (const [name, bag] of Object.entries(content_presets)) {
			if (!/^[\w-]+$/.test(name)) {
				throw new Error(`[ogygia] content.presets: '${name}' — preset names are identifiers ([A-Za-z0-9_-]).`);
			}
			if (!bag || typeof bag !== 'object' || Object.keys(bag).length === 0) {
				throw new Error(`[ogygia] content.presets.${name} is empty — a preset with nothing is a mistake.`);
			}
			for (const k of Object.keys(bag)) {
				if (k !== 'markdown') {
					throw new Error(
						`[ogygia] content.presets.${name}: unknown key \`${k}\`. A content preset takes \`markdown\`.`
					);
				}
			}
		}
		islandBridge.contentPresets = content_presets as typeof islandBridge.contentPresets;
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
		emitted_island_chunks,
		transportable_modules,
		runtime_marks
	} = program;
	const register = program.register.bind(program);
	const unregister_host = program.unregister_host.bind(program);

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
	/** tag → self-contained factory source from og.$ rewrites — served by the fn-manifest virtual
	 *  so client bundles can register factories pre-hydration (the payload-source fallback covers
	 *  bundles that miss it). */
	const dollar_hoists = new Map();

	let root;
	let base = '';
	let libDir;
	let is_dev = false;
	/** Resolved `resolve.alias` entries — passed to bake()'s rolldown eval so `$lib` etc. resolve. */
	let resolve_alias = [];
	let is_build = false;
	let is_ssr = false;
	let scanned = false;
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

	const virtualPathFor = (_hostId, iid) => islandVirtualId(iid);

	/** Dev URL for dynamic `import(entry)` of a virtual island module. */
	const devUrlFor = (virtualPath) => {
		const prefix = base && base !== '/' ? base.replace(TRAILING_SLASH, '') : '';
		return prefix + '/@id/' + virtualPath;
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
		{ const __ps=__P?performance.now():0; walk(src_dir); if(__P)__prof.prescanMs+=performance.now()-__ps; }

		// Complete `island_graph` TRANSITIVELY, before the bundler resolves a single module. `walk`
		// above registered each island's OWN component; this marks everything those components import
		// (and what THOSE import, …) as island code too — so the `$app/*` shim decision is DETERMINISTIC
		// rather than a build-order race. Without it, a component shared between an island and a
		// non-island route is marked lazily during Rolldown's own walk: if its `$app/*` (or its
		// transform) resolves before the island path marks it, it keeps Kit's real client store — which
		// under `csr = false` is never populated → `page.url` undefined → the island crashes at hydrate.
		// (This is the race the `?og-region` module-id fork tried to fix; that fork broke Svelte's
		// scoped-CSS emission, so membership rides OUTSIDE the module id here — the walk only READS.)
		//
		// PERF: strictly O(reachable modules). A SINGLE shared `seen` set means each file is read and
		// scanned exactly once and never re-descended — no per-root re-walk, no depth multiplier (cf.
		// the depth-25 O(2^depth) usage-walk regression this deliberately avoids). A cheap regex lists
		// specifiers (over-collection is harmless — an unresolvable one is skipped); package/alias
		// specifiers stop the walk, where the lazy resolveId marking below stays as the backstop.
		{
			const __ws = __P ? performance.now() : 0;
			const seen_dep = new Set<string>();
			const DEP_EXTS = ['', '.svelte', '.ts', '.js', '.svelte.ts', '.svelte.js', '.mjs'];
			const resolve_dep = (spec: string, importerAbs: string): string | null => {
				const base = resolveFoucImportSpec(spec, importerAbs, libDir);
				if (!base) return null; // package / alias — the lazy resolveId marking is the backstop
				for (const ext of DEP_EXTS) {
					try { if (fs.statSync(base + ext).isFile()) return base + ext; } catch { /* not this ext */ }
				}
				for (const ext of DEP_EXTS.slice(1)) {
					const idx = path.join(base, 'index' + ext);
					try { if (fs.statSync(idx).isFile()) return idx; } catch { /* not an index */ }
				}
				return null;
			};
			const IMPORT_SPEC = /\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]/g;
			const walk_dep = (abs: string) => {
				const norm = strip_id(abs);
				if (seen_dep.has(norm)) return;
				seen_dep.add(norm);
				island_graph.add(norm);
				if (!/\.(svelte|ts|js|mjs|cjs)$/.test(norm)) return;
				const src = readFile(norm);
				if (src == null) return;
				IMPORT_SPEC.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = IMPORT_SPEC.exec(src))) {
					const spec = m[1] || m[2] || m[3];
					if (!spec || spec[0] === '\0' || spec.startsWith('$app/') || spec.startsWith('$env/') || spec.startsWith('virtual:')) continue;
					const dep = resolve_dep(spec, norm);
					if (dep) walk_dep(dep);
				}
			};
			for (const entry of registry.values()) {
				if (entry.componentPath) walk_dep(strip_id(entry.componentPath));
			}
			if (__P) __prof.prescanMs += performance.now() - __ws;
		}

		// A transportable class (`static wire = import.meta.og.wire(…)`) means island props can carry a
		// live wired object, revived through the wire codec — so this app needs the wire runtime.
		if (transportable_modules.size > 0) runtime_marks.wire = true;
		// prescan walked every host — the capability marks are now COMPLETE, so the generated sticky
		// runtime entry can bundle only the features this app uses (else it stays kitchen-sink).
		runtime_marks.complete = true;
		// Fold the resolved feature set into the runtime chunk name so it busts when the emitted bytes
		// change (see `runtime_chunk_filename`). Deterministic across both build legs (same prescan).
		runtime_feature_hash = crypto.createHash('sha256').update(resolveFeatures(runtime_marks).join(',')).digest('hex').slice(0, 8);
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
				new CompileCtx({ root, base, libDir, is_dev, id_salt, visibleMargin, presets, import_keys })
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
						fileName: runtime_chunk_filename()
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
			if (source === V_FN_MANIFEST) return RESOLVED(V_FN_MANIFEST);
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
				// A BARE specifier a generated island module re-emits (a marked package import like
				// `import TabGroup from 'ogygia/content/tab-group' with { wake: 'load' }`, or a specifier
				// its child synth re-imports) that Vite cannot resolve must fail HERE, loudly — falling
				// through surfaces later as an opaque "Failed to resolve import" with the virtual module
				// as the only context. Relative/absolute/virtual sources keep Vite's own error path.
				if (
					!resolved &&
					!source.startsWith('.') &&
					!source.startsWith('\0') &&
					!source.startsWith('virtual:') &&
					!path.isAbsolute(source)
				) {
					throw new Error(
						`[ogygia] cannot resolve '${source}' imported by the generated island module for ` +
							`${path.relative(root, host)}. That island was marked on a package import, so the ` +
							`specifier must resolve from the host file: check the package is installed and its ` +
							`"exports" map exposes this subpath (with a "svelte" condition for .svelte components).`
					);
				}
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
				// Ensure prescan ran so `runtime_feature_hash` matches the client emit's filename (both
				// legs prescan the same source → same feature set → same name).
				if (!is_dev && !scanned) prescan();
				const url = is_dev ? '/@id/__x00__' + V_RUNTIME : hashed_runtime_url || runtime_chunk_url();
				return `export default ${JSON.stringify(url)};`;
			}
			if (id === RESOLVED(V_FN_MANIFEST)) {
				// og.$ factories, registered pre-hydration. Self-contained by the capture law, so
				// emitting source is a pure text move. DEV: `dollar_hoists` is complete by the time
				// the browser requests this virtual (SSR transformed the hosts first) — emit directly.
				// BUILD: this module loads BEFORE all client transforms ran (the ordering trap), so
				// emit a rename-proof PLACEHOLDER — a globalThis bridge + a token that `renderChunk`
				// patches once every transform has contributed (registrations then use the bridge,
				// immune to bundler identifier renaming). Strict-CSP apps get a real manifest this
				// way; the payload-source eval fallback becomes the exception, not the path.
				const regs = () =>
					[...dollar_hoists.entries()]
						.map(([tag, src]) => `globalThis.__og_reg_fn(${JSON.stringify(tag)}, (${src}));`)
						.join('\n');
				const bridge = `import { __register_fn } from 'ogygia/internal';\nglobalThis.__og_reg_fn = __register_fn;\n`;
				if (is_dev) return bridge + regs();
				return bridge + `/*__OGYGIA_FN_MANIFEST__*/`;
			}
			if (id === RESOLVED(V_RUNTIME_ENTRY)) {
				// Ensure every host was walked (marks complete) before selecting features.
				if (!scanned) prescan();
				const { code } = generateRuntimeEntrySource(runtime_marks, RUNTIME_DIR);
				// og.$ factories register before any island hydrates (sync fn-ref resolution)
				return `import ${JSON.stringify(V_FN_MANIFEST)};\n` + code;
			}
			if (id === RESOLVED(V_RUNTIME)) {
				// Dev sticky: kitchen-sink package entry. Build uses the hashed emitFile chunk. An EXPLICIT
				// `bootDev()` call (not a bare side-effect import) so Vite's dep prebundler can't tree-shake
				// the boot away — the bug that left `sideEffects:false` apps with a runtime that never woke.
				return `import { bootDev } from 'ogygia/runtime'; bootDev();`;
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
				return island_deps_module(ssr, is_dev);
			}
			if (id === RESOLVED(V_TRANSPORT)) {
				return transport_module(universal_hooks);
			}
			if (id === RESOLVED(V_SECRET)) {
				return secret_module(ssr, build_secret);
			}
			if (id === RESOLVED(V_SIGN)) {
				return sign_module(ssr, HMAC_MODULE);
			}
			if (id === RESOLVED(V_REQUEST_EVENT)) {
				// ServerIsland may appear in a transformed page module that Kit's client guard scans.
				// Real getRequestEvent only on SSR; client stub never runs (holes fetch HTML).
				if (!ssr) {
					return `export function getRequestEvent() { throw new Error('[ogygia] getRequestEvent is server-only'); }`;
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
						`export function mintServerIsland(_entry, _props, _ttl) { return ''; }\n` +
						// The known-fingerprints set is a server-only nav signal; the client always sees empty.
						`export function known_region_fps() { return new Set(); }`
					);
				}
				return `export { makeRegionEndpoint, mintServerIsland, known_region_fps } from ${JSON.stringify(REGION_ENDPOINT_MODULE)};`;
			}
			if (id === RESOLVED(V_RATE_LIMIT)) {
				return rate_limit_module(ssr, rate_limit);
			}
			if (id === RESOLVED(V_ROUTER_CONFIG)) {
				return router_config_module(router_enabled, router_view_transitions);
			}
			if (id === RESOLVED(V_SESSION_COOKIE)) {
				return session_cookie_module(ssr, session_cookie);
			}
			if (id === RESOLVED(V_REGION_TTL)) {
				return region_ttl_module(ssr, region_ttl);
			}
			if (id === RESOLVED(V_SERVER_MANIFEST)) {
				// Populated in BOTH dev and build (unlike the client manifest, which dev fills from URLs).
				if (ssr) prescan();
				return server_manifest_module(ssr, program, is_dev, devUrlFor);
			}
			if (id === RESOLVED(V_MANIFEST)) {
				return manifest_module(is_dev);
			}
			if (id === RESOLVED(V_TRANSPORTABLES)) {
				// Eager-registration manifest of transportable-class modules (prescan-discovered).
				prescan();
				return transportables_module(transportable_modules);
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

		async transform(code, id, options) {
			const ssr = options?.ssr === true;
			// Discover islands before any module is transformed so island_graph is populated
			// even when an island entry component is processed before its host page.
			if (!scanned) prescan();

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

			// `import.meta.og.wire` — the transportable-codec key, rewritten to `Symbol.for('ogygia.wire')`
			// BEFORE either branch (island transform / svelte compile / ts region minting) sees the code,
			// so the class body's computed key is a real symbol expression by compile time. Extension-aware
			// and AST-precise (see og-wire.ts); a no-op unless the marker is actually present.
			if (out.includes('import.meta.og.wire')) {
				const rewritten = rewrite_wire(out, id_n, CONSTRUCT_MARKUP_EXTS);
				if (rewritten !== out) {
					out = rewritten;
					map = null;
					touched = true;
				}
			}

			// `import.meta.og.$(fn)` — hoist a function so its VALUE crosses a boundary as a fn
			// ref (og-dollar.ts). Exact marker ('.$state' can never match) + AST verification.
			if (out.includes('import.meta.og.$')) {
				const rel_dollar = path.relative(root, id_n.split('?')[0]).split(path.sep).join('/');
				const res = rewrite_dollar(out, id_n, rel_dollar, CONSTRUCT_MARKUP_EXTS);
				if (res.code !== out) {
					out = res.code;
					map = null;
					touched = true;
					for (const h of res.hoists) dollar_hoists.set(h.tag, h.factory_src);
				}
			}

			// `import.meta.og.store(factory)` — assert a store factory: registered under a build
			// tag at module load, products branded (og-store.ts).
			if (out.includes('import.meta.og.store')) {
				const rel_store = path.relative(root, id_n.split('?')[0]).split(path.sep).join('/');
				const rewritten = rewrite_store(out, id_n, rel_store, CONSTRUCT_MARKUP_EXTS);
				if (rewritten !== out) {
					out = rewritten;
					map = null;
					touched = true;
				}
			}

			// AUTO-BRAND provable store factories (export const x = (seed) => store-shape) so the
			// registered-factory tier needs zero authoring for the common shapes. App source only —
			// never node_modules (their factories can't self-register on the client anyway).
			if (!id_n.includes('node_modules') && !id_n.startsWith(PKG_ROOT) && /export\s+const/.test(out)) {
				const rel_auto = path.relative(root, id_n.split('?')[0]).split(path.sep).join('/');
				const branded = auto_brand_stores(out, id_n, rel_auto, CONSTRUCT_MARKUP_EXTS);
				if (branded !== out) {
					out = branded;
					map = null;
					touched = true;
				}
			}

			// `import.meta.og.code(source, lang, meta?)` — a highlighted snippet, baked to a static
			// region through the app's own Shiki fence pipeline (same themes/transformers/meta parsers)
			// and inlined as `og_html_region("…")`. Async (Shiki). Runs before the island transform so
			// the injected `og_html_region` import + region value flow through normally. The renderer is
			// dynamically imported so a build without any `code()` call never loads Shiki here.
			if (out.includes('import.meta.og.code') || out.includes('import.meta.og.md')) {
				const md_cfg = islandBridge.markdownConfig as MarkdownOptions | null;
				const rewritten = await rewrite_code(out, id_n, CONSTRUCT_MARKUP_EXTS, async (call) => {
					if (call.kind === 'md') return render_markdown(md_cfg, call.source);
					const region = await render_snippet(md_cfg, call.source, call.lang, call.meta);
					return region.html;
				});
				if (rewritten !== out) {
					out = rewritten;
					map = null;
					touched = true;
				}
			}

			// `import.meta.og.bake(fn)` — run fn at build (rolldown-bundle the imports it uses +
			// execute), devalue-serialize the result, inline it as a literal, and drop imports that only
			// fed a baked fn. Extension-aware (whole file for .ts/.js, `<script>` blocks for .svelte).
			// Runs before the island transform so downstream sees plain data, not a call.
			if (out.includes('import.meta.og.bake')) {
				const __bk=__P?performance.now():0;
				const rewritten = await rewrite_bake(out, id_n, {
					alias: resolve_alias,
					root,
					markupExts: CONSTRUCT_MARKUP_EXTS
				});
				if (rewritten !== out) {
					out = rewritten;
					map = null;
					touched = true;
				}
				if (__P) { __prof.bakeMs += performance.now() - __bk; __prof.bakeN++; }
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

		renderChunk(code) {
			// Patch the fn-manifest placeholder now — every transform has run, so `dollar_hoists`
			// is complete. Pre-minify (this plugin is enforce:pre) and rename-proof (registrations
			// go through the globalThis bridge the placeholder module installed).
			if (!code.includes('/*__OGYGIA_FN_MANIFEST__*/')) return null;
			const regs = [...dollar_hoists.entries()]
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

			// ── Guardrail: a content collection must never reach a CLIENT chunk ──────────────
			// Ground truth is the finished bundle. A compiled corpus module (.svx/.md) in a client
			// chunk means a `content()` collection was imported into client-shipped code (usually an
			// island), which drags its eager `import.meta.glob` — every doc — into the browser. On a
			// csr=false site the corpus renders server-side and should never appear here, so any hit is
			// a real leak. A warning, not a throw: the guardrail must never break a build.
			try {
				const CORPUS_RE = /\.(svx|md)(\?|$)/;
				const leaks: Array<{ chunk: string; modules: string[] }> = [];
				for (const [key, chunk] of Object.entries(bundle)) {
					if ((chunk as { type?: string }).type !== 'chunk') continue;
					const ids: string[] =
						(chunk as { moduleIds?: string[] }).moduleIds ??
						Object.keys((chunk as { modules?: Record<string, unknown> }).modules ?? {});
					// A `?…type=style…`/`lang.css` sub-import is the content module's CSS FACE, emitted on
					// purpose (see the client-leg content-CSS emit) — it carries no corpus JS, so it is not
					// a leak. Only a real corpus JS module counts.
					const corpus = ids.filter(
						(id) => CORPUS_RE.test(id) && !is_island_path(id) && !CONTENT_STYLE_QUERY_RE.test(id)
					);
					if (corpus.length) leaks.push({ chunk: (chunk as { fileName?: string }).fileName ?? key, modules: corpus });
				}
				if (leaks.length) {
					const all = [...new Set(leaks.flatMap((l) => l.modules))];
					const sample = all.slice(0, 5).map((m) => '    ' + path.relative(root, m.split('?')[0])).join('\n');
					console.warn(
						`[ogygia] content leaked into the CLIENT bundle: ${all.length} corpus module(s) (.svx/.md) shipped to the browser (in chunk '${leaks[0].chunk}').\n` +
							`  A content() collection was imported into client-shipped code — usually an island — which drags its eager import.meta.glob (every doc) in.\n` +
							`  Fix: keep the collection in a server-only module (or a .remote.ts) and feed islands DATA (refs) via props or a remote, never the collection itself.\n` +
							`${sample}${all.length > 5 ? '\n    …' : ''}`
					);
				}
			} catch {
				/* a guardrail must never break the build */
			}

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

			const json = JSON.stringify({ ...map, content_css, fn_manifest: Object.fromEntries(dollar_hoists) });
			const handoff = islandDepsHandoffPath(root);
			fs.mkdirSync(path.dirname(handoff), { recursive: true });
			fs.writeFileSync(handoff, json);
			// Adapter-friendly copy next to the server bundle (Kit SSR out already exists).
			const server_copy = path.join(
				root,
				'.svelte-kit',
				'output',
				'server',
				'og-region-deps.json'
			);
			try {
				fs.mkdirSync(path.dirname(server_copy), { recursive: true });
				fs.writeFileSync(server_copy, json);
			} catch {
				/* ignore — handoff path is enough for prerender */
			}

			// Inline the manifest into the SSR bundle so serverless tracing ships it. The co-located JSON
			// above is dropped by @vercel/nft (it is fs-read, not imported), which is why held/dual regions
			// that cross the wire rendered unstyled on Vercel/Netlify. Patch the token slot the island-deps
			// virtual emits (V_ISLAND_DEPS load) in every server chunk that carries it; unpatched builds keep
			// the fs fallback (adapter-node, dev-preview).
			try {
				const server_dir = path.join(root, '.svelte-kit', 'output', 'server');
				const token = '__OGYGIA_ISLAND_DEPS_INLINE__';
				// Escape for BOTH quote styles: the SSR bundler may emit the slot in single OR double
				// quotes, and an escaped quote is valid in either literal \u2014 so this is safe regardless.
				const inline = json
					.replace(/\\/g, '\\\\')
					.replace(/'/g, "\\'")
					.replace(/"/g, '\\"')
					.replace(/\u2028/g, '\\u2028')
					.replace(/\u2029/g, '\\u2029');
				const patch_server = (dir) => {
					let entries;
					try {
						entries = fs.readdirSync(dir, { withFileTypes: true });
					} catch {
						return;
					}
					for (const e of entries) {
						const full = path.join(dir, e.name);
						if (e.isDirectory()) {
							patch_server(full);
							continue;
						}
						if (!e.name.endsWith('.js')) continue;
						let code;
						try {
							code = fs.readFileSync(full, 'utf8');
						} catch {
							continue;
						}
						if (!code.includes(token)) continue;
						fs.writeFileSync(full, code.split(token).join(inline));
					}
				};
				patch_server(server_dir);
			} catch {
				/* ignore — fs fallback still serves adapter-node / preview */
			}
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
