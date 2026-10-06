/**
 * The `Compiler` — the driver / long-lived compile session. It holds the `Program` (cross-file
 * linker), the resolved `CompileCtx`, and the per-file transform cache, and exposes the file-local
 * front-end as one call: `transform(source, id)` → parse ▸ analyze ▸ lower ▸ emit (today fused inside
 * `transformHost`), memoized. It is bundler-agnostic by construction — it imports no Vite; the adapter
 * drives it. That independence is the design goal: a future REPL is just a second adapter over the
 * same driver, feeding a `CompileCtx` + source and rendering the returned freeze.
 *
 * The transform cache is content-keyed (`hit.code === source`), so a changed source misses and
 * recomputes on its own; the linker's `unregister_host` deliberately does NOT clear it.
 */
import { fs, path, createHash } from './host.js';
import { fnv1a32 } from '../runtime/hash.js';
// `performance` is a global in both Node (≥16) and the browser — no import, so the driver graph loads
// in the browser compiler (Observatory REPL) without pulling node:perf_hooks.
const performance = globalThis.performance;
import {
	transformHost,
	transformTsRegions,
	wrapperVirtualId,
	ISLAND_DIR,
	is_island_path,
	CLIENT_BINDING_STUB
} from './region/transform.js';
import {
	routeCsrIsFalse,
	routeCsrIsTrue,
	hasAnyCsrTrueRoute,
	clean_stale_ogygia_dirs,
	kit_dirs
} from './kit.js';
import { run_module_macros } from './macros/pipeline.js';
import { is_script_request } from './script-request.js';
import {
	generateHydrateFeaturesSource,
	generateRuntimeEntrySource,
	resolveFeatures
} from './link/runtime-entry.js';
import {
	resolveFoucImportSpec,
	FOUC_CSS_PREFIX,
	FOUC_SCOPED_PREFIX,
	type FoucAlias
} from './fouc-css.js';
import {
	moduleHasTransportable,
	svelteModuleHasTransportable,
	appendSvelteModuleRegistrations,
	appendTransportRegistrations
} from './content/transportables.js';
import { rewrite_loaders } from './content/loaders.js';
import { rewrite_regions } from './content/regions.js';
import { materialize } from './content/git.js';
import { rewrite_lake_import_to_placeholder, APP_SHIM_IMPORT, FOREIGN_HYDRATE_MARK } from './region/emit.js';

/** the import that makes an app a federation participant (its island entries keep the foreign-hydrate exports) */
const FEDERATION_SPEC = 'ogygia/federation';
import { island_deps_module } from './link/island-deps.js';
import { island_shim_source, runtime_shim_source } from './link/entry-shim.js';
import { context_string_keys, source_uses_ogygia_context } from './link/context-detect.js';
import { collect_flag_sites } from './flags.js';
import { router_css_roots, router_css_module } from './link/router-css.js';
import {
	secret_module,
	sign_module,
	profiler_config_module,
	freeze_config_module,
	rate_limit_module,
	session_cookie_module,
	region_ttl_module,
	route_csr_module,
	freeze_routes_module
} from './link/caps.js';
import { router_config_module } from './link/router-config.js';
import {
	transport_module,
	transportables_module,
	kit_transport_module,
	source_crosses_wire
} from './link/transport.js';
import { server_manifest_module, server_island_ids } from './link/server-manifest.js';
import { manifest_module } from './link/manifest.js';
import { dev_hmr_client_source } from './dev/dev-hmr.js';
import { same_module_path, island_vpaths_affected_by_file } from './dev/hmr.js';
import {
	RESOLVED,
	V_RUNTIME_URL,
	V_RUNTIME,
	V_FN_MANIFEST,
	V_RUNTIME_ENTRY,
	V_HYDRATE_FEATURES,
	V_DEV_HMR,
	V_DEV_HMR_URL,
	V_DEVTOOLS_BOOT,
	V_DEVTOOLS_BOOT_URL,
	V_DEVTOOLS_META,
	V_ISLAND_DEPS,
	V_TRANSPORT,
	V_KIT_TRANSPORT,
	V_ROUTER_CSS,
	V_SECRET,
	V_SIGN,
	V_REQUEST_EVENT,
	V_ROUTE_CSR,
	V_REGION_ENDPOINT,
	V_PROFILER_CONFIG,
	V_PROFILER_MAPS,
	PROFILER_MAPS_PLACEHOLDER,
	V_RATE_LIMIT,
	V_ROUTER_CONFIG,
	V_SESSION_COOKIE,
	V_REGION_TTL,
	V_SERVER_MANIFEST,
	V_MANIFEST,
	V_TRANSPORTABLES,
	V_TRANSPORTABLES_EAGER,
	V_FREEZE_CONFIG,
	V_FREEZE_ROUTES
} from './ids.js';
import { strip_id, host_key } from './program.js';
import { mentions_page_store, page_data_keys_answer } from './link/page-keys.js';
import {
	export_names,
	is_registry_stub_id,
	registry_client_id,
	registry_client_path,
	registry_client_source,
	registry_stub_names,
	registry_stub_source,
	static_script_specs
} from './link/registry-stub.js';
import { island_host_loaded } from './link/emit-gate.js';
import { stamp_opaque } from './ownership-stamps.js';
import type { MarkdownOptions } from '../content/markdown/index.js';
import type { Program, RegisterResult } from './program.js';
import type { CompileCtx } from './ctx.js';

/** A file-local transform result: the Vite `{ code, map }` plus the descriptors the linker registers. */
type TransformResult = RegisterResult & { code: string; map: unknown };
/** The chunk names our content-hashed entries are emitted under (`entry_file_pattern` keys on them). */
const ISLAND_ENTRY_NAME_PREFIX = 'og-region.';
const RUNTIME_ENTRY_NAME = 'og-runtime';

/** The bundler's `emitFile` for an entry chunk, by `name` (the output pattern content-hashes it).
 *  Returns the reference id. */
export type EmitChunk = (chunk: { type: 'chunk'; id: string; name: string }) => string;

/** Shared OGYGIA_PROFILE instrument — the adapter owns the maps/counters; the driver writes into
 *  them so the transform-phase metrics (and the determinism digest source) live with the transform. */
export interface Profiler {
	prof: {
		transformMs: number;
		transformN: number;
		transformHit: number;
		prescanMs: number;
		bakeMs: number;
		bakeN: number;
		resolveMs: number;
		loadMs: number;
	};
	P: boolean;
	outHash: Map<string, number>;
}

const LEADING_SLASH = /^\//;
const BACKSLASH_G = /\\/g;
const COMPONENT_EXT_RE = /\.(svelte|js|ts)$/;
/** A Kit route host file (`+page.svelte`, `+layout.ts`, …) — the page node's own client modules. */
const ROUTE_HOST_FILE_RE = /^\+(page|layout)\.(svelte|ts|js|mjs)$/;
/** A `.ts`/`.js` module that can be a region registry (a minted `.ts` region host). */
const TS_REGISTRY_EXT_RE = /\.(ts|js|mjs)$/;
/** A Svelte rune module (`.svelte.ts` / `.svelte.js`). */
const SVELTE_RUNE_MODULE_RE = /\.svelte\.(ts|js)$/;
/** The plugin-context resolver the client-leg registry decision walks import edges with. */
type RegistryResolve = (
	source: string,
	importer: string,
	opts: { skipSelf: boolean }
) => Promise<{ id: string } | null>;
/** A script module the seed-shaping analysis parses with oxc (`.svelte.ts` included). */
const SCRIPT_MODULE_RE = /\.(?:[cm]?[jt]sx?)$/;
const SOURCE_EXT_RE = /\.(svelte|ts|js|mjs|cjs)$/;
const CONTENT_CALL_RE = /\bcontent\s*\(/;
const SERVER_MODULE_EXT_RE = /\.(server|remote)\.(ts|js|mjs)$/;
const SERVER_DIR_RE = /\/(src\/lib\/server|server)\//;
const OG_PRESET_QUERY_RE = /[?&]og_preset=([\w-]+)/;
/** Static import / export-from / `import()` specifiers, for the island-graph dep walk (shared `g`
 *  regex — `walk_dep` resets `lastIndex` before each scan). */
const IMPORT_SPEC_G =
	/\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]/g;
/** The extensions an extension-less island import may resolve to (bare, then index files). */
const ISLAND_DEP_EXTS = ['', '.svelte', '.ts', '.js', '.svelte.ts', '.svelte.js', '.mjs'];

// Import/export-from specifier extraction for the router-css closure (link/router-css.ts). A cheap
// regex over raw source — a stray match in a comment/string just fails to resolve later, harmless.
// Runs once per file in the prescan walk; module-level so it compiles once.
const MODULE_SPEC_RE =
	/(?:^|[\n;])\s*(?:import|export)\b[^;'"()]*?from\s*['"]([^'"]+)['"]|(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
const ROUTER_PKG_SPEC = 'ogygia/router';
/** flag()/experiment() live on the ROOT export — the flag-site sweep only runs on importers. */
const OGYGIA_ROOT_SPEC = 'ogygia';
/** Manifest path for a flag site: package-relative for declared surfaces, root-relative else. */
function flag_site_file(
	ctx: { pkg_identity(p: string): string | null; root: string },
	full: string
): string {
	return (ctx.pkg_identity(full) ?? path.relative(ctx.root, full)).split(path.sep).join('/');
}
function extract_module_specs(src: string): string[] {
	MODULE_SPEC_RE.lastIndex = 0;
	const specs: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = MODULE_SPEC_RE.exec(src))) specs.push(m[1] ?? m[2]);
	return specs;
}

// one shared FNV-1a-32 (runtime/hash.ts is the pure, import-anywhere home)
const fnv = fnv1a32;

/** Once per module id: a dependency file carries ogygia marks but its package declares no
 *  `ogygia.files` — the marks are then silently inert (a `with { }` attribute is valid syntax,
 *  it just never rewrites), which is the worst way to fail. Say it loudly, once. */
const warned_undeclared = new Set<string>();
function warn_undeclared_pkg_marks(id: string): void {
	if (warned_undeclared.has(id)) return;
	warned_undeclared.add(id);
	console.warn(
		`[ogygia] ${id} uses ogygia marks, but its package declares no ` +
			`\`"ogygia": { "files": [...] }\` — the marks are IGNORED. Add the field to that ` +
			`package's package.json (npm-"files"-style paths/globs) to put it on ogygia's compile surface.`
	);
}

/** The client-hooks boot snippet for a generated runtime entry: an import of the runtime runner and
 *  a call that dynamic-imports the app's `hooks.client.*` — empty when the app has none. Runs the
 *  file's `init` on boot for csr=false pages (the runner skips a csr=true document). */
/**
 * DEV: the folder `ogygia/runtime` resolves to — this package's own `exports["./runtime"]` (the
 * dev boot imports that specifier). A published package points it at `dist/runtime` (= the
 * prebuilt `runtime_dir`); this repo's workspace points it at `src/runtime` (`.ts` files). Null
 * when it cannot be read (then `runtime_dir` stands). Once per runtime dir.
 */
const dev_runtimes = new Map<string, { dir: string; ts: boolean } | null>();
function dev_runtime_of(runtime_dir: string): { dir: string; ts: boolean } | null {
	if (dev_runtimes.has(runtime_dir)) return dev_runtimes.get(runtime_dir)!;
	let out: { dir: string; ts: boolean } | null = null;
	try {
		const pkg_dir = path.dirname(path.dirname(runtime_dir));
		const pkg = JSON.parse(fs.readFileSync(path.join(pkg_dir, 'package.json'), 'utf8'));
		const exp = pkg?.exports?.['./runtime'];
		const rel = typeof exp === 'string' ? exp : exp?.default;
		if (typeof rel === 'string') {
			const file = path.join(pkg_dir, rel);
			if (fs.existsSync(file)) out = { dir: path.dirname(file), ts: file.endsWith('.ts') };
		}
	} catch {
		out = null;
	}
	dev_runtimes.set(runtime_dir, out);
	return out;
}

function client_hooks_boot(ctx: CompileCtx): { imports: string; call: string } {
	if (!ctx.client_hooks) return { imports: '', call: '' };
	const runner = `${ctx.runtime_dir}/client-hooks.js`.replace(BACKSLASH_G, '/');
	return {
		imports: `import { run_app_client_hooks as __og_run_client_hooks } from ${JSON.stringify(runner)};\n`,
		call: `__og_run_client_hooks(() => import(${JSON.stringify(ctx.client_hooks)}));\n`
	};
}

export class Compiler {
	readonly program: Program;
	readonly transform_cache = new Map<string, { code: string; result: unknown }>();
	readonly profiler: Profiler;
	/** Every `import.meta.og.$` hoist collected across the build (tag → factory source). Filled by
	 *  `macros()`; drained by the adapter's fn-manifest emit (dev load leg, renderChunk, writeBundle). */
	readonly dollar_hoists = new Map<string, string>();
	/** `prescan()` is once-per-session — guarded so the adapter can call it from any hook. */
	#scanned = false;

	/** Does the app federate (any module imports `ogygia/federation`)? Then its island entries keep the
	 *  foreign-hydrate exports another app's runtime wakes them through. Read off the prescan. */
	#federates(): boolean {
		this.prescan();
		for (const specs of this.program.module_specs.values()) if (specs.includes(FEDERATION_SPEC)) return true;
		return false;
	}

	/**
	 * DEV: the server-island ids the last emitted `virtual:ogygia/server-manifest` carried. A HOST edit
	 * drops its islands' rows (`invalidate_for_file`) and invalidates the manifest; Kit re-imports the
	 * handle BEFORE the page transform re-registers them, so that manifest is emitted WITHOUT the ids —
	 * and nothing re-invalidated it afterwards: every hole answered 403 until a restart. The adapter
	 * asks `server_manifest_stale()` after each transform and invalidates again when a registered
	 * server id is missing from this set. `null` until the first emit (nothing to compare).
	 */
	#emitted_server_ids: Set<string> | null = null;

	/** True (once) when a server island registered since the last manifest emit — re-invalidate it. */
	server_manifest_stale(): boolean {
		const emitted = this.#emitted_server_ids;
		if (!emitted) return false;
		for (const id of server_island_ids(this.program)) {
			if (!emitted.has(id)) {
				this.#emitted_server_ids = null; // the next emit records the fresh set
				return true;
			}
		}
		return false;
	}
	/** Hosts already warned about a mis-placed `content()` collection (warn once per file). */
	readonly #content_placement_warned = new Set<string>();
	#ctx: CompileCtx | null = null;

	constructor(program: Program, profiler: Profiler) {
		this.program = program;
		this.profiler = profiler;
	}

	/** Bind the resolved compile context (called once the bundler has resolved the build). */
	configure(ctx: CompileCtx) {
		this.#ctx = ctx;
	}

	/**
	 * Devtools: the `island id → component name` map, read at call time off the live registry (so a
	 * dev-server middleware serves a COMPLETE, current map — no stale virtual-module snapshot). Keys
	 * are the island id (`<hash>` in `virtual:ogygia/island/<hash>.js`); values the component's
	 * basename. A held/generated island with no source file is skipped (the tab keeps its short hash).
	 */
	region_names(): Record<string, string> {
		const names: Record<string, string> = {};
		for (const [iid, vpath] of this.program.by_id) {
			const cp = this.program.registry.get(vpath)?.componentPath;
			if (!cp) continue;
			const base = (cp.split('?')[0].split('#')[0].split('/').pop() || '').replace(
				COMPONENT_EXT_RE,
				''
			);
			if (base && base !== iid) names[iid] = base;
		}
		return names;
	}

	/**
	 * Run the module-macro passes (`wire`/`$`/`store`/auto-brand/`code`/`bake`) over one module —
	 * the leg that must land before the island transform / svelte compile / ts-region minting sees
	 * it. `source` is the CURRENT text (a content-preset tag may already have edited it). Returns
	 * `{ code, touched }`; the caller nulls its own sourcemap when `touched`.
	 */
	macros(source: string, id: string): Promise<{ code: string; touched: boolean }> {
		const ctx = this.#ctx!;
		return run_module_macros(
			source,
			id,
			{
				root: ctx.root,
				resolveAlias: ctx.resolve_alias,
				markdownConfig: ctx.markdown_config as MarkdownOptions | null,
				pkgRoot: ctx.pkg_root,
				dollarHoists: this.dollar_hoists
			},
			this.profiler
		);
	}

	/**
	 * Transform a content (`.svx`/`.md`) island source the markdown preprocessor hands back — always
	 * wrapper-linked (`linkVirtual: true`), because a preprocessor output is shared across the ssr/client
	 * legs and can't take the csr=false stub split; content files aren't routes, so they'd get wrappers
	 * anyway. Registers the descriptors and returns the rewritten code, or `null` when it has no islands.
	 * This is the transform the adapter installs on the content-island bridge.
	 */
	transform_content_island(source: string, filename: string): string | null {
		const result = this.transform(source, filename, {
			ssr: false,
			linkVirtual: true
		}) as TransformResult | null;
		if (!result || !result.islands?.length) return null;
		this.program.register(result, filename);
		return result.code;
	}

	/**
	 * Lower one file: run the fused parse ▸ analyze ▸ lower ▸ emit front-end and register nothing —
	 * the caller registers the returned descriptors into the `Program`. Memoized per
	 * `(id, ssr, linkVirtual, routeCsr)`, content-gated on the source.
	 */
	/**
	 * The REAL source file a module derives from. A real file is its own origin. A generated entry
	 * (a portable-snippet synth, re-processed under its `virtual:ogygia/island/<iid>.svelte` id)
	 * resolves through the registry's `hostPath` — transitively, so an entry minted while re-processing
	 * another entry still lands on the file the outermost slice was cut from. This is the ONE rule
	 * `resolve_id` already applies to an entry's plain imports; threading it into the transform keeps
	 * a re-minted marked import (whose resolved path is BAKED into a region module's source, bypassing
	 * resolveId) on the same base. Normalized like `transform_module`'s gate (`strip_id`, `/@id/`).
	 */
	#origin_of(id: string): string {
		const { registry } = this.program;
		const bare = (s: string) => {
			const n = strip_id(s);
			return n.startsWith('/@id/') ? n.slice(5) : n;
		};
		let cur = bare(id);
		// No depth ceiling — snippet-in-snippet nests as deep as an app cares to go. The only thing to
		// guard against is a registry cycle, and a visited set does that exactly.
		const seen = new Set<string>([cur]);
		for (;;) {
			const host = registry.get(cur)?.hostPath;
			if (!host) break;
			const next = bare(host);
			if (seen.has(next)) break;
			seen.add(next);
			cur = next;
		}
		return cur;
	}

	transform(source: string, id: string, opts: { ssr?: boolean; linkVirtual?: boolean } = {}) {
		const ctx = this.#ctx!;
		const { prof, P, outHash } = this.profiler;
		const ssr = opts.ssr !== false;
		// Scale: csr=false CLIENT hosts must not statically import portable wrappers (or the
		// hydrate entries those wrappers pull in). Kit still emits those page nodes; sharing
		// the emitFile module with the page graph forces Rolldown thin `og-region.*`
		// facades. SSR keeps real wrappers for HTML; csr=true client keeps them so Kit can
		// hydrate islands as normal components. Hydration always uses `import(entry)`.
		const routesDir = kit_dirs(ctx.root).routes_dir;
		// A csr=false LAYOUT can wrap a csr=true child page — there Kit hydrates the layout, so its
		// chrome islands must be REAL wrappers on the client (Region degrades them inline via
		// `documentIsCsrTrue`), NOT the thin stub. Only when the app actually has a csr=true route,
		// and only for `+layout.svelte` hosts (bounded chrome, unlike N page islands).
		const is_layout_host = path.basename(id) === '+layout.svelte';
		const link_virtual =
			opts.linkVirtual !== undefined
				? opts.linkVirtual
				: ssr ||
					!routeCsrIsFalse(id, routesDir) ||
					(is_layout_host && hasAnyCsrTrueRoute(routesDir));
		// Tri-state route csr, threaded into the transform (see transformHost's routeCsr branch):
		//   true  → csr=true route host: ogygia steps aside — strip the host's island directives to
		//           plain so Kit compiles + hydrates them inline.
		//   false → csr=false route host: keep islands (the normal island transform).
		//   undefined → not a route host (shared lib component): its csr depends on the page that
		//           renders it, so it keeps its islands.
		// The inline-vs-island choice itself is decided at RUNTIME by `documentIsCsrTrue` (context.ts) —
		// one fact read identically on both legs — which replaced the old per-host CSR_TRUE_KEY marker +
		// csr=false reset cascade. `route_csr` still drives the compile-time strip/link decisions below.
		const route_csr = routeCsrIsTrue(id, routesDir)
			? true
			: routeCsrIsFalse(id, routesDir)
				? false
				: undefined;
		// `ssr` joins the key because transformHost output legitimately differs by pass — the client
		// build side-effect-imports fouc-css for a lake binding (its scoped CSS is on no client chunk),
		// the SSR build must not. Without `ssr` here a layout+csr=true host (where ssr and client share
		// `link_virtual`) would reuse the SSR result on the client and drop that CSS link.
		const cache_key = `${id}\0${ssr ? 's' : 'c'}\0${link_virtual ? '1' : '0'}\0${route_csr === true ? 't' : route_csr === false ? 'f' : 'n'}`;
		const hit = this.transform_cache.get(cache_key);
		if (hit && hit.code === source) {
			if (P) prof.transformHit++;
			return hit.result;
		}
		const th0 = P ? performance.now() : 0;
		const result = transformHost(source, id, {
			root: ctx.root,
			libDir: ctx.libDir,
			readFile: (abs: string) => ctx.read_file(abs),
			pathModule: path,
			dev: ctx.is_dev,
			virtualPathFor: (_hostId: string, iid: string) => ctx.island_virtual_id(iid),
			wrapperPathFor: (_hostId: string, iid: string) => wrapperVirtualId(iid),
			devUrlFor: (virtualPath: string) => ctx.dev_url_for(virtualPath),
			originOf: (host: string) => this.#origin_of(host),
			appDir: ctx.app_dir,
			visibleMargin: ctx.visibleMargin,
			presets: ctx.presets,
			importKeys: ctx.import_keys,
			idSalt: ctx.id_salt,
			pkg_identity: (abs: string) => ctx.pkg_identity(abs),
			linkVirtualIsland: link_virtual,
			clientBindingStub: CLIENT_BINDING_STUB,
			routeCsr: route_csr,
			ssr
		});
		if (P) {
			prof.transformMs += performance.now() - th0;
			prof.transformN++;
			outHash.set(cache_key, fnv(JSON.stringify((result as { code?: unknown })?.code ?? result)));
		}
		this.transform_cache.set(cache_key, { code: source, result });
		return result;
	}

	/**
	 * Mint the `.ts` / `.js` regions in one module — `with { wake: … }` load/remote imports become
	 * island descriptors. The ts-region half of the front-end, sharing the driver's resolved context
	 * (so both the prescan and the transform hook mint identically). Not memoized — the caller gates it
	 * on the id + marker; the returned descriptors are the caller's to `register`.
	 */
	ts_regions(source: string, id: string) {
		const ctx = this.#ctx!;
		return transformTsRegions(source, id, {
			root: ctx.root,
			libDir: ctx.libDir,
			pathModule: path,
			dev: ctx.is_dev,
			virtualPathFor: (_hostId: string, iid: string) => ctx.island_virtual_id(iid),
			devUrlFor: (virtualPath: string) => ctx.dev_url_for(virtualPath),
			appDir: ctx.app_dir,
			importKeys: ctx.import_keys,
			idSalt: ctx.id_salt,
			pkg_identity: (abs: string) => ctx.pkg_identity(abs)
		});
	}

	/**
	 * Discover every island up front — walk `src/`, transform each `.svelte` host and mint each
	 * `.ts`/`.js` region, register the descriptors, then complete `island_graph` TRANSITIVELY and
	 * finalize the runtime capability marks (so the sticky runtime entry bundles only what the app
	 * uses, and its immutable chunk name busts on a feature-set change). Once per session, so the
	 * adapter can call it from any hook. Populates the `Program`; the fs walk is the only side effect.
	 */
	prescan() {
		if (this.#scanned) return;
		this.#scanned = true;
		const ctx = this.#ctx!;
		const { prof, P } = this.profiler;
		const program = this.program;
		const { registry, island_graph, transportable_modules, runtime_marks } = program;
		const root = ctx.root;
		const libDir = ctx.libDir;

		const src_dir = path.join(root, 'src');
		clean_stale_ogygia_dirs(src_dir);
		const scan_file = (full: string, name: string) => {
			if (name.endsWith('.svelte')) {
				const src = ctx.read_file(full);
				if (src == null) return;
				if (!runtime_marks.context && source_uses_ogygia_context(src)) runtime_marks.context = true;
				if (!program.crosses_wire && source_crosses_wire(src)) program.crosses_wire = true;
				{
					// Router-css closure data: this module's import specs + whether it defines routers.
					const specs = extract_module_specs(src);
					if (specs.length) program.module_specs.set(full, specs);
					if (specs.includes(ROUTER_PKG_SPEC)) program.router_modules.add(full);
					if (specs.includes(OGYGIA_ROOT_SPEC))
						program.flag_sites.push(...collect_flag_sites(src, full, flag_site_file(ctx, full)));
				}
				// A `<script module>` transportable class goes in the manifest too (keyed by the
				// .svelte path — side-effect-importing the component runs its module registration).
				if (svelteModuleHasTransportable(src, full)) transportable_modules.add(full);
				const result = this.transform(src, full);
				if (result) program.register(result, full);
			} else if (
				(name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.mjs')) &&
				!name.endsWith('.d.ts')
			) {
				// `.ts` / `.js` region mints (load / remote functions). Discover them up front so a
				// deferred region's server-manifest entry exists before the endpoint is ever hit —
				// lazy transform order would otherwise leave the id missing (403 on first fetch).
				const src = ctx.read_file(full);
				if (src == null) return;
				if (!runtime_marks.context && source_uses_ogygia_context(src)) runtime_marks.context = true;
				if (
					!program.crosses_wire &&
					(name.endsWith('.remote.ts') || name.endsWith('.remote.js') || source_crosses_wire(src))
				)
					program.crosses_wire = true;
				{
					// Router-css closure data: this module's import specs + whether it defines routers.
					const specs = extract_module_specs(src);
					if (specs.length) program.module_specs.set(full, specs);
					if (specs.includes(ROUTER_PKG_SPEC)) program.router_modules.add(full);
					if (specs.includes(OGYGIA_ROOT_SPEC))
						program.flag_sites.push(...collect_flag_sites(src, full, flag_site_file(ctx, full)));
				}
				// Transportable classes go into the eager-registration manifest so an island
				// receiving one as a prop never has to import the class itself.
				if (moduleHasTransportable(src, full)) transportable_modules.add(full);
				const result = this.ts_regions(src, full);
				if (result) program.register(result, full);
			}
		};
		const walk = (dir: string) => {
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
				} else {
					scan_file(full, entry.name);
				}
			}
		};
		{
			const __ps = P ? performance.now() : 0;
			walk(src_dir);
			// Extra island roots beyond the app's src (e.g. the profiler UI, `ogygia({ profiler: true })`):
			// server-only library components whose client hydrate chunks only build if the prescan — which
			// runs in both build legs — registers them here. Same `walk`, so same iid ⇒ the SSR shell's
			// `entry` matches the chunk this emits.
			// Declared compile surfaces beyond src (`"ogygia": { "files": […] }` in a DEP's
			// package.json; ogygia's own profiler UI rides the same rail as an internal entry):
			// the same walk/scan as app src, so a library island gets everything an app island gets
			// (feature marks, deferred manifests, wired classes, router-css specs) and both build
			// legs mint the same iids. Only DECLARED packages, only their DECLARED paths.
			for (const p of ctx.pkg_scan) {
				for (const d of p.dirs) walk(d);
				for (const f of p.files) scan_file(f, f.slice(f.lastIndexOf('/') + 1));
			}
			if (P) prof.prescanMs += performance.now() - __ps;
		}

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
		// PERF: strictly O(reachable modules) — see `mark_island_closure`: one shared `seen` set for
		// the life of the program, so each file is read and scanned exactly once, never re-descended.
		{
			const __ws = P ? performance.now() : 0;
			for (const entry of registry.values()) {
				if (entry.componentPath) this.mark_island_closure(entry.componentPath);
			}
			if (P) prof.prescanMs += performance.now() - __ws;
		}

		// CONTEXT-BOUNDARY diagnostic: an island (or a component inside it — the whole island closure) that
		// READS a string-keyed `getContext(…)` for a key nothing in the island's own code SETS, while this
		// app registers NO ogygia context provider. On a csr=false page the page/layout `<script>` never
		// runs on the client, so a value set with Svelte's own `setContext` in a page/layout is gone by the
		// time the island hydrates in isolation — the island reads `undefined`, renders a different tree,
		// and Svelte silently discards its server DOM on hydration (`data-og-recovered`). Naming it here
		// turns that silent discard into a build-time pointer at the fix.
		//
		// Precision: gated to "no ogygia bridge at all" (`!runtime_marks.context`) so it never false-warns
		// an app that DOES bridge (there a matching provided key resolves); and a key the island's OWN code
		// both sets and reads (a component library using context WITHIN one hydration root) is subtracted
		// out, since that needs no bridge. The runtime recovery diagnostic covers the partial-bridge case.
		// Reads are cache hits — the closure walk already read these files.
		if (!runtime_marks.context) {
			const reads: { file: string; keys: string[] }[] = [];
			const island_set = new Set<string>();
			for (const file of island_graph) {
				if (!file.endsWith('.svelte') && !SCRIPT_MODULE_RE.test(file)) continue;
				const src = ctx.read_file(file);
				if (src == null) continue;
				const { reads: r, sets } = context_string_keys(
					src,
					file.endsWith('.svelte') ? 'svelte' : 'script'
				);
				for (const k of sets) island_set.add(k);
				if (r.length) reads.push({ file, keys: r });
			}
			for (const { file, keys } of reads) {
				for (const key of keys) {
					if (island_set.has(key)) continue; // the island provides it itself, within one root
					console.warn(
						`[ogygia] island code ${path.relative(root, file)} reads getContext('${key}'), but this app ` +
							`registers no ogygia context provider and no island code sets '${key}'. On a csr=false page a ` +
							`value set with Svelte's setContext in a page/layout does NOT cross the island boundary — the ` +
							`island reads undefined on the client, re-renders a different tree, and Svelte discards its ` +
							`server-rendered DOM on hydration (a silent full re-render). Fix: provide '${key}' with ` +
							`setContext / <Provide> / createContext imported from 'ogygia' (in a csr=false layout); the ` +
							`read stays getContext('${key}').`
					);
				}
			}
		}

		// A transportable class (`static wire = import.meta.og.wire(…)`) means island props can carry a
		// live wired object, revived through the wire codec — so this app needs the wire runtime.
		if (transportable_modules.size > 0) runtime_marks.wire = true;
		// prescan walked every host — the capability marks are now COMPLETE, so the generated sticky
		// runtime entry can bundle only the features this app uses (else it stays kitchen-sink).
		runtime_marks.complete = true;
		// Fold the resolved feature set into the runtime chunk name so it busts when the emitted bytes
		// change (see `runtime_chunk_filename`). Deterministic across both build legs (same prescan).
		program.runtime_feature_hash = createHash('sha256')
			.update(resolveFeatures(runtime_marks).join(','))
			.digest('hex')
			.slice(0, 8);
	}

	/** Files the island-closure walk has already read (see `mark_island_closure`). Lives for the
	 *  program, so a closure marked at prescan is never re-walked when a later island shares it. */
	#island_closure_seen = new Set<string>();

	/**
	 * Mark `componentAbs` and EVERYTHING it imports (transitively) as island code, so the `$app/*`
	 * shim decision for each of those modules is DETERMINISTIC — before the bundler resolves a single
	 * one of them. A module shared between an island and a non-island route is otherwise marked lazily
	 * during the bundler's own walk: if its `$app/*` resolves before the island path reaches it, it
	 * keeps Kit's real client store — which under `csr = false` is never populated → `page.url`
	 * undefined, `page.data` empty → the island crashes or reads nothing at hydrate. Shimming it is
	 * right in both worlds: on a Kit-booted document the shim reads Kit's real page (the kit-page
	 * thread). (The `?og-region` module-id fork was tried and reverted — it broke Svelte's scoped-CSS
	 * emission; membership rides OUTSIDE the module id here, the walk only READS.)
	 *
	 * Follows relative, `$lib` AND the app's aliases (`kit.alias` / `resolve.alias` — a customer's
	 * `$lib_x/utils/boot` import was where the walk used to stop, and its `$app/state` went to whichever
	 * page loaded first). Bare package specifiers stop it; the lazy resolveId marking stays their
	 * backstop. Called at prescan for every island, and again in dev for an island registered by a
	 * later transform (a file added while the server runs). Returns the modules marked for the first
	 * time by this call, so a dev caller can drop their cached transforms.
	 */
	/** DEV: modules `mark_island_closure` marked for the first time AFTER prescan — an island a later
	 *  transform registered (a file added while the server runs). Each may already sit in the dev
	 *  server's module graph, transformed with Kit's real `$app/*` for a non-island importer; the
	 *  plugin drains this list and drops those cached transforms so the next load re-resolves them. */
	#closure_added: string[] = [];

	#mark_registered_closures(result: TransformResult): void {
		if (!this.#ctx!.is_dev) return;
		for (const isl of result.islands ?? []) {
			if (isl.componentPath)
				this.#closure_added.push(...this.mark_island_closure(isl.componentPath));
		}
	}

	/** DEV: take the modules newly marked as island code since the last drain (see above). */
	drain_closure_marks(): string[] {
		const out = this.#closure_added;
		this.#closure_added = [];
		return out;
	}

	mark_island_closure(componentAbs: string): string[] {
		const ctx = this.#ctx!;
		const { island_graph } = this.program;
		const aliases = ctx.resolve_alias as readonly FoucAlias[];
		const added: string[] = [];
		const resolve_dep = (spec: string, importerAbs: string): string | null => {
			const base = resolveFoucImportSpec(spec, importerAbs, ctx.libDir, aliases);
			if (!base) return null; // a bare package specifier — the lazy resolveId marking is the backstop
			for (const ext of ISLAND_DEP_EXTS) {
				try {
					if (fs.statSync(base + ext).isFile()) return base + ext;
				} catch {
					/* not this ext */
				}
			}
			for (const ext of ISLAND_DEP_EXTS.slice(1)) {
				const idx = path.join(base, 'index' + ext);
				try {
					if (fs.statSync(idx).isFile()) return idx;
				} catch {
					/* not an index */
				}
			}
			return null;
		};
		const walk = (abs: string) => {
			const norm = strip_id(abs);
			if (this.#island_closure_seen.has(norm)) return;
			this.#island_closure_seen.add(norm);
			if (!island_graph.has(norm)) {
				island_graph.add(norm);
				added.push(norm);
			}
			if (!SOURCE_EXT_RE.test(norm)) return;
			const src = ctx.read_file(norm);
			if (src == null) return;
			IMPORT_SPEC_G.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = IMPORT_SPEC_G.exec(src))) {
				const spec = m[1] || m[2] || m[3];
				if (
					!spec ||
					spec[0] === '\0' ||
					spec.startsWith('$app/') ||
					spec.startsWith('$env/') ||
					spec.startsWith('virtual:')
				)
					continue;
				const dep = resolve_dep(spec, norm);
				if (dep) walk(dep);
			}
		};
		walk(componentAbs);
		return added;
	}

	/**
	 * Scan ENTRIES for Vite's dep optimizer: every hydrate island's component file and the host file
	 * that places it — real, absolute, on-disk source paths. Under `csr = false` Kit ships no client
	 * entry and registers only `routes/**\/+*` as scan entries, so Vite's scanner reaches an island
	 * only when a route file imports it statically. An island behind a block registry, an
	 * `import.meta.og.regions()` glob or a `.remote.ts` mint is never crawled: its client deps are
	 * discovered LAZILY on its first wake, and every discovery re-optimizes, rotates the optimizer's
	 * browserHash and full-reloads — on a large app a reload storm that never settles. The adapter
	 * appends these to `optimizeDeps.entries` (dev) so Vite's OWN scanner crawls them at startup with
	 * the full plugin pipeline: its resolver, every plugin's `resolveId` (a `?client` import resolves
	 * through vite-plugin-iso-import), a linked workspace package followed as SOURCE and never
	 * pre-bundled, the app's `exclude` honoured.
	 *
	 * Deliberately NOT a self-computed `optimizeDeps.include` list. A resolver that is not Vite's
	 * mis-classifies something Vite knows — a plugin query, a workspace link, an `exports` map — and
	 * a wrong `include` hands rolldown an id it cannot load: `UNLOADABLE_DEPENDENCY`, a dead dev
	 * server (two field-reported regressions). An entry can only ever ADD a crawl root; what the
	 * crawl finds is Vite's call. A `defer` island renders on the server (its closure is not client
	 * code) and a lake ships no client JS, so neither is an entry; the host file covers a
	 * portable-snippet synth, which has no component file of its own. Needs `prescan()`; deduped,
	 * sorted, existing source files only.
	 */
	island_scan_entries(): string[] {
		const { registry, region_kinds } = this.program;
		const out = new Set<string>();
		const add = (p: string | null | undefined) => {
			if (!p) return;
			const abs = strip_id(p);
			if (!SOURCE_EXT_RE.test(abs)) return; // only what the scanner can parse
			try {
				if (fs.statSync(abs).isFile()) out.add(abs);
			} catch {
				/* a virtual id or a vanished file — not a crawl root */
			}
		};
		for (const entry of registry.values()) {
			if (entry.role !== 'entry' || entry.server) continue;
			if (region_kinds.get(entry.id) !== 'hydrate') continue;
			add(entry.componentPath);
			add(entry.hostPath);
		}
		return [...out].sort();
	}

	/** The feature-selected runtime chunk name (immutable-cached). Needs prescan to have run for a
	 *  non-empty feature hash; both build legs prescan the same source → the same name. */
	runtime_chunk_filename(): string {
		return this.#ctx!.runtime_chunk_filename(this.program.runtime_feature_hash);
	}

	/** Public URL of the runtime chunk (asset prefix + filename — honors a non-root base / assets CDN). */
	runtime_chunk_url(): string {
		return this.#ctx!.runtime_chunk_url(this.program.runtime_feature_hash);
	}

	/**
	 * Client-build chunk emit (via the injected `emitFile`): the feature-selected runtime entry (when
	 * `emitRuntime`), then one chunk per deduped HYDRATE region id. IDENTITY vs LOCATION: SSR bakes the
	 * stable name (`island_public_url`) as the region's identity; the file the browser loads is named
	 * by its content (the bundler hashes it), and the bundle end hands the stable → hashed map to the
	 * server (the handoff's `entries`). The stable name is emitted too, as a shim of the hashed file.
	 * csr=false hosts omit wrapper imports so this emit owns the module. Idempotent per id.
	 */
	#router_css_roots_cache: string[] | null = null;
	/** The server-router component roots (link/router-css.ts). Build: prescan is complete before any
	 *  consumer runs — memoized. Dev: modules appear lazily (HMR), recompute per call. */
	router_css_roots(): string[] {
		const ctx = this.#ctx!;
		if (ctx.is_build && this.#router_css_roots_cache) return this.#router_css_roots_cache;
		// One path for ALL router modules — app source AND declared surfaces (the shipped profiler
		// router imports the literal 'ogygia/router', so the prescan of its declared entry detects
		// it like any app router module; no injected special case). The walk's recursion is bounded
		// by prescanned module_specs, so profiler-router's type-import of `./index.js` dead-ends
		// instead of dragging the host graph in.
		const roots = new Set(
			router_css_roots(this.program.router_modules, this.program.module_specs, ctx.libDir)
		);
		const sorted = [...roots].sort();
		if (ctx.is_build) this.#router_css_roots_cache = sorted;
		return sorted;
	}

	/** Does the program hold ANY hydrate island? The runtime-emission gate needs this because
	 *  `hasAnyCsrFalseRoute` only inspects Kit PAGE leaves — an app whose islands live solely in
	 *  router-rendered components (a pure-router / fragment-only service has ZERO `+page` files)
	 *  answers "no csr=false page" while its documents still `<script src>` the runtime. */
	/**
	 * Server-only islands — `render: 'deferred'` with no client chunk — and the component file each
	 * renders. Nothing on any page links such a component's CSS (Kit collects stylesheets from the
	 * client graph; this subtree is never in it), so the client leg compiles each one's whole tree
	 * CSS into a dedicated asset the hole response links (vite/index.ts, `region_css_links`).
	 * Sorted for determinism; a component shared by several ids is emitted once (by `abs`).
	 */
	server_island_css_roots(): Array<{ iid: string; abs: string }> {
		const out: Array<{ iid: string; abs: string }> = [];
		for (const [iid, vpath] of this.program.by_id) {
			const entry = this.program.registry.get(vpath);
			if (!entry?.server || !entry.componentPath) continue;
			if (this.program.region_kinds.get(iid) === 'hydrate') continue;
			out.push({ iid, abs: host_key(entry.componentPath) });
		}
		return out.sort((a, b) => (a.iid < b.iid ? -1 : a.iid > b.iid ? 1 : 0));
	}

	/** The public URL key a server island's CSS is handed off under (matches `island_url[id]`). */
	island_public_url(iid: string): string {
		return this.#ctx!.island_public_url(iid);
	}

	has_hydrate_regions(): boolean {
		for (const kind of this.program.region_kinds.values()) if (kind === 'hydrate') return true;
		return false;
	}

	/** The server leg's real module graph, for the client-leg handoff (link/emit-gate.ts). */
	ssr_transformed_hosts(): string[] {
		return [...this.program.ssr_transformed].sort();
	}

	/**
	 * Client leg: the runtime chunk + one deterministic chunk per deduped hydrate region. `loaded` —
	 * the server leg's transformed-module set (the handoff the plugin reads) — gates the emit to
	 * islands whose HOST the server bundle actually contains; `null` (no handoff: standalone, or a
	 * client-only build) keeps every prescanned island, as before. Returns how many were skipped.
	 */
	emit_build_chunks(
		emitFile: EmitChunk,
		{ emitRuntime, loaded = null }: { emitRuntime: boolean; loaded?: Set<string> | null }
	): number {
		this.island_entry_refs.clear();
		this.runtime_entry_ref = null;
		if (emitRuntime) {
			// Unresolved virtual id — resolve_id/emit synthesize the feature-selected entry. Named, not
			// fixed: the bundler hashes its content into the file name (its imports included), and the
			// server finds that name in the build handoff. The stable name is a shim (`entry_shims`).
			// (named with its features: `og-runtime-<features>.<hash>.js` says which runtime it is)
			const feat = this.#ctx!.runtime_features(this.program.runtime_feature_hash);
			this.runtime_entry_ref = emitFile({ type: 'chunk', id: V_RUNTIME_ENTRY, name: RUNTIME_ENTRY_NAME + (feat ? '-' + feat : '') });
		}
		const { region_kinds, by_id, emitted_island_chunks, registry } = this.program;
		let skipped = 0;
		for (const [rid, kind] of region_kinds) {
			if (kind !== 'hydrate') continue;
			const virtualPath = by_id.get(rid);
			if (!virtualPath) continue;
			if (emitted_island_chunks.has(rid)) continue;
			if (!island_host_loaded(registry.get(virtualPath)?.hostPath, loaded)) {
				skipped++;
				continue;
			}
			this.emit_island_entry(emitFile, rid, virtualPath);
		}
		return skipped;
	}

	/** Client-build refs of each emitted island entry (by island id) and of the runtime entry: the
	 *  bundle end turns them into the hashed file names the handoff maps the stable names to. */
	readonly island_entry_refs = new Map<string, string>();
	runtime_entry_ref: string | null = null;

	/**
	 * At the bundle's end (the names are final): each entry's IDENTITY → its LOCATION. `islands` maps
	 * an island entry's hashed file to its identity (the collector keys every map by identity);
	 * `locations` is what the handoff carries to the server (`entries`): identity → served path.
	 * `get_file_name` is the bundler's `this.getFileName`.
	 */
	entry_locations(get_file_name: (ref: string) => string): {
		islands: Map<string, string>;
		runtime: string | null;
		runtime_file: string | null;
		locations: Record<string, string>;
	} {
		const islands = new Map<string, string>();
		const locations: Record<string, string> = {};
		const served = (file: string) => (file.startsWith('/') ? file : '/' + file);
		for (const [rid, ref] of this.island_entry_refs) {
			const file = get_file_name(ref);
			const identity = this.island_public_url(rid);
			islands.set(file, identity);
			locations[identity] = served(file);
		}
		let runtime: string | null = null;
		let runtime_file: string | null = null;
		if (this.runtime_entry_ref) {
			runtime_file = get_file_name(this.runtime_entry_ref);
			runtime = this.runtime_chunk_url();
			locations[runtime] = served(runtime_file);
		}
		return { islands, runtime, runtime_file, locations };
	}

	/** One hydrate island's entry, content-hashed by the bundler (its stable-name shim is written at
	 *  the bundle's end: `entry_shims`). */
	emit_island_entry(emitFile: EmitChunk, rid: string, virtualPath: string): void {
		this.program.emitted_island_chunks.add(rid);
		this.island_entry_refs.set(rid, emitFile({ type: 'chunk', id: virtualPath, name: ISLAND_ENTRY_NAME_PREFIX + rid }));
	}

	/**
	 * The output file pattern for one of OUR entries (by the chunk name `emit_island_entry` / the
	 * runtime emit gave it), else null (the app's own naming applies). Readable and content-hashed:
	 * `<appDir>/immutable/og-region.<iid>.<hash>.js`, `…/og-runtime-<features>.<hash>.js` — the hash is the
	 * cache law, the name is for people (a network tab, a CDN rule, a profile). It never equals a
	 * stable name, which has no hash segment.
	 */
	entry_file_pattern(chunk_name: string | undefined): string | null {
		if (!chunk_name) return null;
		const ours =
			chunk_name.startsWith(ISLAND_ENTRY_NAME_PREFIX) ||
			chunk_name === RUNTIME_ENTRY_NAME ||
			chunk_name.startsWith(RUNTIME_ENTRY_NAME + '-');
		if (!ours) return null;
		return `${this.#ctx!.app_dir}/immutable/[name].[hash].js`;
	}

	/**
	 * The stable-name shims (link/entry-shim.ts), for the bundle's end (the names are final): one per
	 * island entry, plus the runtime's — each a plain file at the old stable name re-exporting the
	 * hashed file. `get_file_name` is the bundler's `this.getFileName`.
	 */
	entry_shims(get_file_name: (ref: string) => string): { fileName: string; source: string }[] {
		const ctx = this.#ctx!;
		const out: { fileName: string; source: string }[] = [];
		for (const [rid, ref] of this.island_entry_refs) {
			const fileName = ctx.island_chunk_filename(rid);
			out.push({ fileName, source: island_shim_source(fileName, get_file_name(ref)) });
		}
		if (this.runtime_entry_ref) {
			const fileName = this.runtime_chunk_filename();
			out.push({ fileName, source: runtime_shim_source(fileName, get_file_name(this.runtime_entry_ref)) });
		}
		return out;
	}

	/**
	 * Emit one ogygia VIRTUAL module's source: the config/capability virtuals (secret / sign / rate-limit
	 * / router / session / ttl / manifests / runtime entry+url / transport / dev-hmr / request-event /
	 * region-endpoint), and the registered island/region sources (with the client leg's `$app/*`-shim +
	 * lake-placeholder rewrites). Returns the source string, or `null` if `id` is not an ogygia virtual —
	 * the adapter owns only the FOUC-css virtuals (they carry a Vite `moduleType`) and the Vite build
	 * value threaded in here (the `universalHooks` path).
	 */
	emit(id: string, { ssr, universalHooks }: { ssr: boolean; universalHooks: string | null }): string | null {
		const ctx = this.#ctx!;
		const program = this.program;
		const is_dev = ctx.is_dev;

		// A csr=false route host's registry import on the client leg (link/registry-stub.ts): the
		// registry's export names as `undefined`, so the host links and ships none of the registry.
		if (is_registry_stub_id(id)) return registry_stub_source(registry_stub_names(id));
		const registry_client = registry_client_path(id);
		if (registry_client) return this.#registry_client_emit(registry_client);

		if (id === RESOLVED(V_RUNTIME_URL)) {
			// The runtime's IDENTITY — dev: the vite dev URL; build: its stable URL. The server bundle
			// is built before the client's, so the content-hashed file the page loads is looked up at
			// render time through the build handoff (`entryLocation`, virtual:ogygia/island-deps).
			// Ensure prescan ran so `runtime_feature_hash` matches the client emit's stable name (both
			// legs prescan the same source → same feature set → same name).
			if (!is_dev) this.prescan();
			const url = is_dev ? '/@id/__x00__' + V_RUNTIME : this.runtime_chunk_url();
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
				[...this.dollar_hoists.entries()]
					.map(([tag, src]) => `globalThis.__og_reg_fn(${JSON.stringify(tag)}, (${src}));`)
					.join('\n');
			const bridge = `import { __register_fn } from 'ogygia/internal';\nglobalThis.__og_reg_fn = __register_fn;\n`;
			if (is_dev) return bridge + regs();
			return bridge + `/*__OGYGIA_FN_MANIFEST__*/`;
		}
		if (id === RESOLVED(V_RUNTIME_ENTRY)) {
			// Ensure every host was walked (marks complete) before selecting features.
			this.prescan();
			const { code } = generateRuntimeEntrySource(program.runtime_marks, ctx.runtime_dir);
			const ch = client_hooks_boot(ctx);
			return ch.imports + code + ch.call;
		}
		if (id === RESOLVED(V_HYDRATE_FEATURES)) {
			// The hydrate core's feature phase, from the same marks as the boot entry. Dev runs the
			// kitchen-sink boot (`bootDev`), so it gets every hydrate-phase feature to match.
			if (!ctx.is_build) {
				// …from the runtime the dev boot actually runs (`ogygia/runtime`, as the app resolves
				// it): a second copy would install the wire into slots the hydrate core never reads
				const rt = dev_runtime_of(ctx.runtime_dir);
				const code = generateHydrateFeaturesSource({}, rt?.dir ?? ctx.runtime_dir, true).code;
				return rt?.ts ? code.split('.js";').join('.ts";') : code;
			}
			this.prescan();
			// og.$ factories register before any island's props are revived (sync fn-ref resolution),
			// i.e. with the hydrate core — not in the boot: the manifest reaches `ogygia/internal`, which
			// island code imports too, and a module the boot shares with island code splits the boot.
			return (
				`import ${JSON.stringify(V_FN_MANIFEST)};\n` +
				generateHydrateFeaturesSource(program.runtime_marks, ctx.runtime_dir).code
			);
		}
		if (id === RESOLVED(V_RUNTIME)) {
			// Dev sticky: kitchen-sink package entry. Build uses the hashed emitFile chunk. An EXPLICIT
			// `bootDev()` call (not a bare side-effect import) so Vite's dep prebundler can't tree-shake
			// the boot away — the bug that left `sideEffects:false` apps with a runtime that never woke.
			{
				const ch = client_hooks_boot(ctx);
				return `import { bootDev } from 'ogygia/runtime';\n${ch.imports}bootDev();\n${ch.call}`;
			}
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
		if (id === RESOLVED(V_DEVTOOLS_BOOT)) {
			// Standalone dock boot for csr=true (Kit-owned) pages: the ogygia runtime never boots
			// there, so mount ONLY the dock — no router/region features (Kit owns navigation). A
			// Kit-hydrated page has no ogygia islands to inspect: the dock shows what the browser saw
			// (the Page tab, fed by the beacon started here) and says why the island tools are absent.
			// Empty when devtools is off (never injected then).
			if (!ctx.devtools) return `export {}`;
			const ui_path = `${ctx.runtime_dir}/../devtools/ui.js`.replace(BACKSLASH_G, '/');
			return (
				// the dev server hands `define`s (the devtools gate among them) to the page as globals
				// from Vite's env module: it must run before the dock reads the gate. Kit's own client
				// (which loads it) comes later in the page, and the dock saw "off" — no dock at all
				(is_dev ? `import '/@vite/env';\n` : '') +
				`import { install_devtools_ui } from ${JSON.stringify(ui_path)};\n` +
				// the beacon's observers from boot: vitals, resources, long tasks, the CPU sampler (the
				// browser buffers most of it, but the sampler and interaction timing start here) — the
				// dock's Page tab reads what the browser saw on a Kit-hydrated page too
				`import { beacon_watch } from ${JSON.stringify(`${ctx.runtime_dir}/beacon.js`.replace(BACKSLASH_G, '/'))};\n` +
				`beacon_watch();\n` +
				`install_devtools_ui({ csr_true: true });\n`
			);
		}
		if (id === RESOLVED(V_DEVTOOLS_META)) {
			// a build: every island's component name, from the prescan (the dev server serves them live)
			if (is_dev) return `export const names = {};`;
			this.prescan();
			return `export const names = ${JSON.stringify(this.region_names())};`;
		}
		if (id === RESOLVED(V_DEVTOOLS_BOOT_URL)) {
			// The served URL the handle injects on csr=true pages. Empty in build/preview and when
			// devtools is off; the vite-dev `/@id/` URL otherwise. Dev-only, matching how apps enable
			// devtools for `vite dev` alone (`devtools: command === 'serve'`).
			if (!ctx.devtools || !is_dev) return `export default '';`;
			return `export default ${JSON.stringify('/@id/__x00__' + V_DEVTOOLS_BOOT)};`;
		}
		if (id === RESOLVED(V_ISLAND_DEPS)) {
			return island_deps_module(ssr, is_dev, path.relative(ctx.root, kit_dirs(ctx.root).out_dir));
		}
		if (id === RESOLVED(V_TRANSPORT)) {
			return transport_module(universalHooks);
		}
		if (id === RESOLVED(V_KIT_TRANSPORT)) {
			// `ogygia.transport` — the codec cluster only when the app crosses a region/wired value over
			// Kit's wire (wire mark, or a remote/region/content producer); an empty map for a pure-island
			// app. transport.js sits one level up from the runtime dir (dist/transport.js).
			const crosses = this.program.runtime_marks.wire === true || this.program.crosses_wire;
			const transport_spec = `${ctx.runtime_dir}/../transport.js`.replace(BACKSLASH_G, '/');
			return kit_transport_module(crosses, transport_spec);
		}
		if (id === RESOLVED(V_ROUTER_CSS)) {
			// Server-router component→CSS registrations (link/router-css.ts). `export {}` for apps
			// without a server router — the router's dynamic import then costs nothing.
			return router_css_module(this.router_css_roots(), {
				root: ctx.root,
				lib_dir: ctx.libDir,
				is_dev,
				read_file: (p) => ctx.read_file(p)
			});
		}
		if (id === RESOLVED(V_SECRET)) {
			return secret_module(ssr, ctx.build_secret);
		}
		if (id === RESOLVED(V_SIGN)) {
			return sign_module(ssr, ctx.hmac_module);
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
					`export function known_region_fps() { return new Set(); }\n` +
					// An island's `data-og-fp` is minted on the server only (a native digest); the
					// client reads the attribute and never computes one.
					`export function islandFingerprint(_entry, _canonical) { return ''; }`
				);
			}
			return `export { makeRegionEndpoint, mintServerIsland, known_region_fps, islandFingerprint } from ${JSON.stringify(ctx.region_endpoint_module)};`;
		}
		if (id === RESOLVED(V_RATE_LIMIT)) {
			return rate_limit_module(ssr, ctx.rate_limit);
		}
		if (id === RESOLVED(V_PROFILER_CONFIG)) {
			return profiler_config_module(ssr, ctx.profiler_config);
		}
		if (id === RESOLVED(V_PROFILER_MAPS)) {
			// a placeholder the build fills with the maps (vite/profiler-maps.ts); anything else: none
			return ssr && ctx.is_build && ctx.profiler_config
				? `export default ${JSON.stringify(PROFILER_MAPS_PLACEHOLDER)};`
				: 'export default null;';
		}
		if (id === RESOLVED(V_FREEZE_CONFIG)) {
			return freeze_config_module(ssr, ctx.freeze_config);
		}
		if (id === RESOLVED(V_ROUTER_CONFIG)) {
			return router_config_module(ctx.router_enabled, ctx.router_view_transitions);
		}
		if (id === RESOLVED(V_SESSION_COOKIE)) {
			return session_cookie_module(ssr, ctx.session_cookie);
		}
		if (id === RESOLVED(V_REGION_TTL)) {
			return region_ttl_module(ssr, ctx.region_ttl);
		}
		if (id === RESOLVED(V_ROUTE_CSR)) {
			return route_csr_module(ssr, kit_dirs(ctx.root).routes_dir);
		}
		if (id === RESOLVED(V_FREEZE_ROUTES)) {
			return freeze_routes_module(
				ssr,
				kit_dirs(ctx.root).routes_dir,
				ctx.freeze_config?.default ?? false
			);
		}
		if (id === RESOLVED(V_SERVER_MANIFEST)) {
			// Populated in BOTH dev and build (unlike the client manifest, which dev fills from URLs).
			if (ssr) this.prescan();
			if (ssr && is_dev) this.#emitted_server_ids = new Set(server_island_ids(program));
			return server_manifest_module(
				ssr,
				program,
				is_dev,
				(vp: string) => ctx.dev_url_for(vp),
				(iid: string) => ctx.island_public_url(iid)
			);
		}
		if (id === RESOLVED(V_MANIFEST)) {
			return manifest_module(is_dev);
		}
		if (id === RESOLVED(V_TRANSPORTABLES_EAGER)) {
			// an island entry's codecs: eager on the server, nothing in the browser (see the ids)
			if (!ssr) return 'export {};\n';
			this.prescan();
			return transportables_module(program.transportable_modules, true, (abs) => abs);
		}
		if (id === RESOLVED(V_TRANSPORTABLES)) {
			// Transportable-class modules (prescan-discovered): eager on the server, lazy loaders on the
			// client (tag paths are root-relative, as the registration writes them).
			this.prescan();
			return transportables_module(
				program.transportable_modules,
				!!ssr,
				(abs) => path.relative(ctx.root, abs).split(path.sep).join('/'),
				program.crosses_wire
			);
		}
		const srcEntry = program.registry.get(id);
		if (srcEntry && srcEntry.role === 'region') {
			// Leg-split: SSR gets the signer-carrying descriptor, client gets metadata only.
			return ssr ? srcEntry.ssrSource! : srcEntry.clientSource!;
		}
		if (srcEntry) {
			// A wake island's WRAPPER is leg-split too: the client leg imports its component through
			// the lazy module (emit.ts `island_wrapper_client_source`), the SSR leg the real entry.
			let src = !ssr && srcEntry.clientSource ? srcEntry.clientSource : srcEntry.source!;
			// An island entry's FOREIGN-HYDRATE exports (fragment federation) exist for another app's
			// runtime: never on the server, and never in an app that does not federate (every island
			// of every other app carried them, and their imports: ~185 B gz and a preload each).
			const foreign = src.indexOf(FOREIGN_HYDRATE_MARK);
			if (foreign !== -1 && (ssr || !this.#federates())) src = src.slice(0, foreign);
			// CLIENT build: rewrite `$app/*` in the GENERATED virtual source to absolute
			// shim paths (defense in depth alongside resolveId island-graph shimming).
			// SSR keeps the real Kit modules (correct server-rendered page.data).
			if (!ssr) {
				src = src.replace(APP_SHIM_IMPORT, (_m: string, _q: string, name: string) =>
					JSON.stringify(ctx.app_shims['$app/' + name])
				);
				// LAKES: swap each lake import for the render-nothing placeholder so the lake
				// component's JS is excluded from this island's client chunk. Handles default
				// (`import Lake from '…'`) and named (`import { Lake } from '…'`) forms.
				for (const local of srcEntry.lakes ?? []) {
					src = rewrite_lake_import_to_placeholder(src, local, ctx.client_binding_stub_file);
				}
			}
			return src;
		}
		return null;
	}

	/**
	 * Resolve an ogygia-owned import id: the virtual-module vocabulary (config/manifest virtuals + FOUC
	 * graph + client-binding stub), and the island CLIENT graph — `$app/*` shims for island importers,
	 * virtual island/wrapper ids, and relative imports of a generated island module resolved against its
	 * host (marking each resolved dep into `island_graph` so its own `$app/*` stays shimmed). `resolve` is
	 * the bundler's own resolver (Vite `this.resolve`), threaded in so the driver stays bundler-agnostic.
	 * Returns a resolved id / result, or `null` to defer to the bundler. The adapter handles the few
	 * package/Kit-specific ids first (ogygia injected imports, Kit's remote runtime, the kit-wire path).
	 */
	async resolve_id(
		source: string,
		importer: string | undefined,
		{
			ssr,
			resolve
		}: {
			ssr: boolean;
			resolve: (
				source: string,
				importer: string,
				opts: { skipSelf: boolean }
			) => Promise<{ id: string } | null>;
		}
	): Promise<string | { id: string } | null> {
		const ctx = this.#ctx!;
		const { registry, island_graph } = this.program;

		if (source === V_FN_MANIFEST) return RESOLVED(V_FN_MANIFEST);
		if (source === V_RUNTIME_URL) return RESOLVED(V_RUNTIME_URL);
		if (source === V_MANIFEST) return RESOLVED(V_MANIFEST);
		if (source === V_RUNTIME) return RESOLVED(V_RUNTIME);
		if (source === V_RUNTIME_ENTRY) return RESOLVED(V_RUNTIME_ENTRY);
		if (source === V_HYDRATE_FEATURES) return RESOLVED(V_HYDRATE_FEATURES);
		if (source === V_DEV_HMR) return RESOLVED(V_DEV_HMR);
		if (source === V_DEV_HMR_URL) return RESOLVED(V_DEV_HMR_URL);
		if (source === V_DEVTOOLS_BOOT) return RESOLVED(V_DEVTOOLS_BOOT);
		if (source === V_DEVTOOLS_BOOT_URL) return RESOLVED(V_DEVTOOLS_BOOT_URL);
		if (source === V_DEVTOOLS_META) return RESOLVED(V_DEVTOOLS_META);
		if (source === V_ISLAND_DEPS) return RESOLVED(V_ISLAND_DEPS);
		if (source === V_KIT_TRANSPORT) return RESOLVED(V_KIT_TRANSPORT);
		if (source === V_ROUTER_CSS) return RESOLVED(V_ROUTER_CSS);
		if (source === V_SECRET) return RESOLVED(V_SECRET);
		if (source === V_SIGN) return RESOLVED(V_SIGN);
		if (source === V_RATE_LIMIT) return RESOLVED(V_RATE_LIMIT);
		if (source === V_PROFILER_CONFIG) return RESOLVED(V_PROFILER_CONFIG);
		if (source === V_PROFILER_MAPS) return RESOLVED(V_PROFILER_MAPS);
		if (source === V_ROUTER_CONFIG) return RESOLVED(V_ROUTER_CONFIG);
		if (source === V_SESSION_COOKIE) return RESOLVED(V_SESSION_COOKIE);
		if (source === V_REGION_TTL) return RESOLVED(V_REGION_TTL);
		if (source === V_ROUTE_CSR) return RESOLVED(V_ROUTE_CSR);
		if (source === V_FREEZE_ROUTES) return RESOLVED(V_FREEZE_ROUTES);
		if (source === V_SERVER_MANIFEST) return RESOLVED(V_SERVER_MANIFEST);
		if (source === V_REQUEST_EVENT) return RESOLVED(V_REQUEST_EVENT);
		if (source === V_REGION_ENDPOINT) return RESOLVED(V_REGION_ENDPOINT);
		// csr=false client hosts rewrite marked bindings here — not a hydrate entry.
		if (source === CLIENT_BINDING_STUB) return ctx.client_binding_stub_file;
		// CSS-only FOUC graph (no component JS) for csr=false client stubs.
		if (source.startsWith(FOUC_CSS_PREFIX) || source.startsWith(FOUC_SCOPED_PREFIX)) {
			return RESOLVED(source);
		}
		if (source === V_TRANSPORT) return RESOLVED(V_TRANSPORT);
		if (source === V_TRANSPORTABLES) return RESOLVED(V_TRANSPORTABLES);
		if (source === V_TRANSPORTABLES_EAGER) return RESOLVED(V_TRANSPORTABLES_EAGER);
		if (source === V_FREEZE_CONFIG) return RESOLVED(V_FREEZE_CONFIG);
		if (is_registry_stub_id(source)) return RESOLVED(source);

		// csr=false CLIENT leg of a BUILD: a route host's import of a `.ts`/`.js` REGION REGISTRY
		// resolves to the registry with its MARKS blanked (link/registry-stub.ts). The marked wrappers
		// would otherwise drag every component + its CSS into the page node's client graph, and Kit
		// links `node.stylesheets` for all of it, rendered or not — the render pass already links what
		// renders. Its PLAIN imports keep their edges: nothing else links their CSS. The registry
		// module itself stays real for csr=true hosts and the island world.
		const registry_stub = await this.#registry_stub_for(source, importer, { ssr, resolve });
		if (registry_stub) return registry_stub;

		// Island CLIENT graph: shim `$app/*` for the virtual module AND every module it
		// pulls in (e.g. `$lib/PageUrlProbe.svelte` importing `$app/state`). Kit's alias
		// would otherwise give islands the uninitialized Kit page (`new URL('a:')` → empty
		// pathname). enforce:'pre' wins over Kit's resolveId. SSR keeps real Kit modules.
		const importer_id = importer ? strip_id(importer) : undefined;
		const from_island = importer_id && (registry.has(importer_id) || island_graph.has(importer_id));
		if (!ssr && from_island && ctx.app_shims[source]) {
			return ctx.app_shims[source];
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
				: path.join(ctx.root, candidate.replace(LEADING_SLASH, ''));
			if (registry.has(abs)) {
				island_graph.add(abs);
				return abs;
			}
		}

		// Virtual island/wrapper module: resolve relative imports to the host file, and mark
		// the resolved id so its own `$app/*` imports hit the shim branch above.
		// Skip ogygia virtual ids (handled above).
		if (importer_id && registry.has(importer_id) && !is_island_path(source)) {
			const host = registry.get(importer_id)!.hostPath ?? '';
			const resolved = await resolve(source, host, { skipSelf: true });
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
						`${path.relative(ctx.root, host)}. That island was marked on a package import, so the ` +
						`specifier must resolve from the host file: check the package is installed and its ` +
						`"exports" map exposes this subpath (with a "svelte" condition for .svelte components).`
				);
			}
			return resolved;
		}
		// Transitive island-graph module (not a virtual entry): mark deps so nested
		// `$app/*` imports stay shimmed. Do NOT resolve island virtual paths via skipSelf.
		if (!ssr && importer_id && island_graph.has(importer_id) && !is_island_path(source)) {
			const resolved = await resolve(source, importer!, { skipSelf: true });
			if (resolved?.id) island_graph.add(strip_id(resolved.id));
			return resolved;
		}
		return null;
	}

	/**
	 * The client-leg registry decision for one import edge (see link/registry-stub.ts). Fires only on
	 * the client leg of a build, for an importer that is either a csr=false ROUTE host (`+page`/
	 * `+layout` `.svelte`/`.ts`/`.js` — the page node's own files, whose client JS never runs) or a
	 * module already in that variant world (its id carries the variant query), and only when the
	 * resolved target is a local `.ts`/`.js` module that IS a region registry or REACHES one through
	 * static script imports. The variant world is contagious along script edges only: a registry
	 * behind a plain helper (`+page.svelte` → `$lib/factory.ts` → `registry.ts`) gets the same
	 * treatment as a direct import, while modules that reach no registry stay shared (no copies).
	 * `.svelte` edges never fork (forking a component's id breaks its scoped CSS). Returns the
	 * variant id, or `null` to let resolution continue.
	 */
	async #registry_stub_for(
		source: string,
		importer: string | undefined,
		{
			ssr,
			resolve
		}: {
			ssr: boolean;
			resolve: RegistryResolve;
		}
	): Promise<string | null> {
		const ctx = this.#ctx!;
		if (ssr || ctx.is_dev || !ctx.is_build || !importer) return null;
		if (source.startsWith('\0') || source.startsWith('virtual:') || source.startsWith('$app/'))
			return null;
		if (registry_client_path(importer) == null && !this.#is_csr_false_route_host(importer))
			return null;
		const target = await this.#resolve_local_script(source, importer, resolve);
		if (!target) return null;
		this.prescan();
		if (!(await this.#reaches_registry(target, resolve))) return null;
		return registry_client_id(target);
	}

	/** True for a csr=false route host file (`+page`/`+layout` `.svelte`/`.ts`/`.js`). A `+page.ts`
	 *  shares its route's world with the sibling `.svelte` host. */
	#is_csr_false_route_host(importer: string): boolean {
		const importer_abs = strip_id(importer);
		const routes_dir = kit_dirs(this.#ctx!.root).routes_dir;
		if (!importer_abs.startsWith(routes_dir + path.sep)) return false;
		const m = ROUTE_HOST_FILE_RE.exec(path.basename(importer_abs));
		if (!m) return false;
		return routeCsrIsFalse(path.join(importer_abs, '..', `+${m[1]}.svelte`), routes_dir);
	}

	/** `source` resolved from `importer` to a local `.ts`/`.js` file on disk, or `null` (virtuals,
	 *  components, assets, unresolvable). Package files count only when the prescan registered them
	 *  as region hosts (an `ogygia.files` package registry) — package internals are never walked. */
	async #resolve_local_script(
		source: string,
		importer: string,
		resolve: RegistryResolve
	): Promise<string | null> {
		// One resolution per (importer, specifier) per build: resolution is deterministic within a
		// build, and every csr=false host and every walked module asks again otherwise.
		const memo_key = strip_id(importer) + '\n' + source;
		const memo = this.#resolve_memo.get(memo_key);
		if (memo !== undefined) return memo;
		const target = await this.#resolve_local_script_uncached(source, importer, resolve);
		this.#resolve_memo.set(memo_key, target);
		return target;
	}
	#resolve_memo = new Map<string, string | null>();
	async #resolve_local_script_uncached(
		source: string,
		importer: string,
		resolve: RegistryResolve
	): Promise<string | null> {
		let resolved: { id: string } | null = null;
		try {
			resolved = await resolve(source, importer, { skipSelf: true });
		} catch {
			return null;
		}
		if (!resolved?.id || resolved.id.startsWith('\0')) return null;
		const target = strip_id(resolved.id);
		if (!TS_REGISTRY_EXT_RE.test(target) || !fs.existsSync(target)) return null;
		// Kit owns these on the client: a `.remote.ts` becomes Kit's fetch stub there (its imports
		// never reach the client graph, and Kit keys its metadata on the exact file id), and a
		// server-only module is refused outright. Neither may fork, and neither leads anywhere.
		// A `.svelte.ts` rune module is compiled by vite-plugin-svelte, keyed on its file name: it
		// never forks either (a registry behind one stays real — a head cost, never a missing style).
		const posix = target.split(path.sep).join('/');
		if (SERVER_MODULE_EXT_RE.test(posix) || SERVER_DIR_RE.test(posix)) return null;
		if (SVELTE_RUNE_MODULE_RE.test(posix)) return null;
		return target;
	}

	/**
	 * Whether `file` is a region registry or reaches one through static script imports (`.svelte`
	 * and package-internal edges are not walked). Every module is read, parsed and walked AT MOST
	 * ONCE per build: a shared helper reached from thousands of import edges answers from the memo.
	 *
	 * Cycles are why that needs care. A NEGATIVE computed while the walk was inside a cycle may
	 * depend on a file still open above it (that file can still turn out to reach a registry), so it
	 * is not final yet. Tarjan's strongly-connected-components bookkeeping decides exactly when it
	 * is: each open file gets its depth on the walk, every step reports the shallowest open file its
	 * subtree looped back to (`low`), and when a file finishes with `low >= depth` nothing below it
	 * depends on anything above it — the file and every file still parked on the component stack
	 * above it form one finished component, all with the same answer. A positive is always final.
	 * (Keeping only top-level negatives instead, as this did first, re-walked every shared module
	 * once per path to it — a large app's build never finished.)
	 */
	async #reaches_registry(file: string, resolve: RegistryResolve): Promise<boolean> {
		return (await this.#reach(file, resolve, new Map(), [])).reaches;
	}
	#reach_memo = new Map<string, boolean>();
	#specs_memo = new Map<string, readonly string[]>();
	async #reach(
		file: string,
		resolve: RegistryResolve,
		open: Map<string, number>,
		component: string[]
	): Promise<{ reaches: boolean; low: number }> {
		const key = host_key(file);
		const memo = this.#reach_memo.get(key);
		if (memo !== undefined) return { reaches: memo, low: Infinity };
		if (this.program.host_index.has(key)) {
			this.#reach_memo.set(key, true);
			return { reaches: true, low: Infinity };
		}
		const open_depth = open.get(key);
		if (open_depth !== undefined) return { reaches: false, low: open_depth };
		if (file.includes('/node_modules/')) return { reaches: false, low: Infinity };
		const depth = open.size;
		open.set(key, depth);
		const parked = component.length;
		component.push(key);
		let reaches = false;
		let low = Infinity;
		for (const spec of this.#script_specs(key, file)) {
			const target = await this.#resolve_local_script(spec, file, resolve);
			if (!target) continue;
			const step = await this.#reach(target, resolve, open, component);
			if (step.low < low) low = step.low;
			if (step.reaches) {
				reaches = true;
				break;
			}
		}
		open.delete(key);
		if (reaches) {
			this.#reach_memo.set(key, true);
			component.length = parked + 1;
			component.pop();
			return { reaches: true, low: Infinity };
		}
		if (low >= depth) {
			// A finished component rooted here: every file parked above it shares this negative.
			for (let i = parked; i < component.length; i++) this.#reach_memo.set(component[i], false);
			component.length = parked;
			return { reaches: false, low: Infinity };
		}
		// Still depends on a file open above: stay parked until that root finishes.
		return { reaches: false, low };
	}
	/** A module's static script specifiers, read and parsed once per build. */
	#script_specs(key: string, file: string): readonly string[] {
		let specs = this.#specs_memo.get(key);
		if (specs === undefined) {
			const src = this.#ctx!.read_file(file);
			specs = src == null ? [] : (static_script_specs(src, file) ?? []);
			this.#specs_memo.set(key, specs);
		}
		return specs;
	}

	/** The client-leg registry source (link/registry-stub.ts): marks blanked, plain imports kept. A
	 *  registry that does not parse falls back to the names-only stub. */
	#registry_client_emit(file: string): string | null {
		const ctx = this.#ctx!;
		const src = ctx.read_file(file);
		if (src == null) return null;
		const keys = ctx.import_keys;
		const region_keys = new Set([keys.wake, keys.render, keys.preset, keys.region]);
		return (
			registry_client_source(src, file, region_keys) ?? registry_stub_source([...export_names(src)])
		);
	}

	/**
	 * Nudge (never error): a `content()` collection defined OUTSIDE a server-only module. Kit's own
	 * guard makes `.server.ts` / `src/lib/server/` / `.remote.ts` mechanically un-importable from
	 * client code — anywhere else, one innocent import from an island or route component can drag the
	 * whole corpus (megabytes of compiled markdown) into a client bundle, silently. Warn once per file.
	 */
	#warn_content_placement(bare: string, source: string) {
		if (this.#content_placement_warned.has(bare)) return;
		const root = this.#ctx!.root;
		// APP source only — never library code (a workspace-linked ogygia sits outside node_modules).
		if (!bare.startsWith(path.join(root, 'src') + path.sep)) return;
		const defines_collection = source.includes('ogygia/content') && CONTENT_CALL_RE.test(source);
		const defines_loader = source.includes('import.meta.og.loader.');
		if (!defines_collection && !defines_loader) return;
		const server_only =
			SERVER_MODULE_EXT_RE.test(bare) || SERVER_DIR_RE.test(bare.slice(root.length));
		if (server_only) return;
		this.#content_placement_warned.add(bare);
		console.warn(
			`[ogygia/content] ${path.relative(root, bare)} defines a collection outside a server-only module. ` +
				`Move it to a \`.server.ts\` file (or \`src/lib/server/\`) and mint remotes for the wire — ` +
				`Kit then guarantees the corpus can never reach a client bundle.`
		);
	}

	/**
	 * The per-file transform pass: content-preset tagging ▸ `import.meta.og.*` macros ▸ the host-island
	 * transform (`.svelte`) ▸ ts/js region minting (`.ts/.js`) ▸ the client `$app/*` shim. Registers the
	 * discovered descriptors into the `Program`, and (client build only) emits the deterministic chunk for
	 * any hydrate island a library component declares that the prescan couldn't see — via the `emitFile`
	 * callback (the one Vite primitive threaded in). Returns the Vite transform result, or `null` if the
	 * module was untouched. `prescan()` runs first so `island_graph` is complete before any module lowers.
	 */
	async transform_module(
		code: string,
		id: string,
		{
			ssr,
			emitFile
		}: {
			ssr: boolean;
			emitFile: EmitChunk;
		}
	): Promise<{ code: string; map: unknown } | null> {
		const ctx = this.#ctx!;
		const program = this.program;
		const { registry, island_graph, emitted_island_chunks } = program;
		const root = ctx.root;

		// Discover islands before any module is transformed so island_graph is populated
		// even when an island entry component is processed before its host page.
		this.prescan();

		// A csr=false client-leg registry variant (link/registry-stub.ts) exists only for its import
		// EDGES (Kit links its plain imports' CSS); its JS never runs. Its id strips to the real
		// registry's path, so the region pipeline below would re-register that host from the
		// blanked source — leave it exactly as emitted.
		if (registry_client_path(id) != null) return null;

		const id_n = strip_id(id);
		// server leg of a build: this module is in the server bundle's real graph (see
		// Program.ssr_transformed / link/emit-gate.ts)
		if (ssr && ctx.is_build) program.ssr_transformed.add(host_key(id_n));

		// SEED SHAPING: a module that imports Kit's page store is read ONCE here, on the compiler's
		// parsers, for the top-level `page.data` keys it can reach (link/page-keys.ts). Recorded by
		// the query-less id so the client `writeBundle` can find it from a chunk's `moduleIds`; the
		// source form is what this pre-transform sees, before the `$app/*` shim rewrite below.
		if (ctx.is_build && mentions_page_store(code)) {
			const clean = id.split('?')[0].split('\\').join('/');
			const kind = clean.endsWith('.svelte')
				? 'svelte'
				: SCRIPT_MODULE_RE.test(clean)
					? 'script'
					: null;
			if (kind) {
				const { keys, reason, pending } = page_data_keys_answer(code, clean, kind);
				if (keys !== null) program.page_keys.set(clean, keys);
				if (reason) program.page_key_reasons.set(clean, reason);
				if (pending.length) program.page_pending.set(clean, pending);
				else program.page_pending.delete(clean);
			}
		}

		// (There is deliberately NO csr=false route-client stripping here. Kit collects a route's
		// CSS manifest from the CLIENT graph — stubbing those modules silently drops every component
		// stylesheet from the prerendered pages. Keeping the corpus out of client bundles is the
		// `.server.ts` placement rule's job — see the content-placement warning — and Kit enforces
		// it mechanically; a csr=false page never fetches its route JS anyway, so the dead client
		// nodes cost disk, not wire.)
		let out = code;
		let map: unknown = null;
		let touched = false;

		// CONTENT-PRESET module variant (`?og_preset=name`, minted by a loader macro's glob query).
		// vite-plugin-svelte strips the query from the `filename` its preprocessors see, so the id
		// can't carry the preset that far — instead this pre-transform (which DOES see the full id)
		// tags the raw markdown with a one-line end-of-file marker; the markdown preprocessor reads
		// it, strips it, and compiles with the preset's merged config. Appended at the END so
		// frontmatter stays on line one; mdsvex never sees it (stripped first).
		if (ctx.content_presets && id.includes('og_preset=')) {
			const m = OG_PRESET_QUERY_RE.exec(id);
			const md_exts = ((ctx.markdown_config as MarkdownOptions | null)?.extensions as
				| string[]
				| undefined) ?? ['.svx', '.md'];
			const file_part = id.slice(0, id.indexOf('?'));
			if (m && md_exts.some((e) => file_part.endsWith(e))) {
				if (!ctx.content_presets[m[1]]) {
					throw new Error(
						`[ogygia] '${id}': unknown content preset '${m[1]}' in the module query. Configured: ${Object.keys(ctx.content_presets).join(', ')}.`
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
		// pass is a no-op unless its exact marker is present. Fills `dollar_hoists` + records bake timing.
		const macroed = await this.macros(out, id_n);
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
			// the component's script only: `Foo.svelte?svelte&type=style&lang.css` is its CSS (the
			// query is gone from `id_n`, so decide on the full id)
			is_script_request(id) &&
			(!is_island_path(bare_v) || portable_entry) &&
			// declared `ogygia.files` surfaces transform unconditionally (full app-source citizenship);
			// undeclared node_modules `.svelte` keeps the legacy hint sniff
			(!in_node_modules || ctx.in_declared_pkg(bare_v) || ctx.has_island_hint(code))
		) {
			// Pass Vite's ssr flag through — client csr=false hosts omit wrapper links.
			// `out`, NOT `code`: the wire/code/md/bake rewrites above already landed in `out`, and
			// the island transform's result REPLACES it — feeding it `code` would silently discard
			// them for any component the host transform touches (import.meta.og.code in a .svelte
			// stayed un-rewritten and exploded at runtime as `undefined.code`).
			const result = this.transform(out, id_n, { ssr }) as TransformResult | null;
			if (result) {
				program.register(result, id_n);
				this.#mark_registered_closures(result);
				out = result.code;
				map = result.map;
				touched = true;

				// Emit the island entry (and its stable-name shim) for any hydrate island discovered HERE
				// that the buildStart prescan couldn't see — i.e. declared inside a library component
				// (host outside the app's `src`). Without this no entry carries its identity: the handoff
				// would have no location for the stable name SSR bakes into `<ogygia-region entry>`.
				if (ctx.is_build && !ssr) {
					for (const isl of result.islands ?? []) {
						const kind = isl.kind ?? (isl.server ? 'defer' : 'hydrate');
						if (kind !== 'hydrate' || !isl.virtualPath || emitted_island_chunks.has(isl.id))
							continue;
						this.emit_island_entry(emitFile, isl.id, isl.virtualPath);
					}
				}
			}

			// A transportable class can live in this component's `<script module>` — register it
			// (same tag scheme, keyed by the `.svelte` path) so it travels like a `.svelte.ts` one.
			if (!id_n.startsWith(ctx.pkg_root)) {
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
		const nm_ts =
			id_n.endsWith('.ts') || id_n.endsWith('.js') || id_n.endsWith('.mjs')
				? id_n.includes('/node_modules/')
				: null;
		// A dependency's `.ts`/`.js` with marks but NO `ogygia.files` declaration would die
		// SILENTLY (the import attribute is valid syntax, it just never rewrites) — say so.
		// (ogygia's OWN modules are exempt: in an installed consumer they live in node_modules and
		// flow through the SSR pipeline (noExternal), and compiler/emit sources legitimately CONTAIN
		// `with { wake` as strings — the hint sniff would warn-spam on every build.)
		if (
			nm_ts === true &&
			!id_n.startsWith(ctx.pkg_root) &&
			!ctx.in_declared_pkg(id_n) &&
			ctx.has_island_hint(out)
		) {
			warn_undeclared_pkg_marks(id_n);
		}
		if (nm_ts !== null && (nm_ts === false || ctx.in_declared_pkg(id_n)) && !is_island_path(id_n)) {
			this.#warn_content_placement(id_n, out);

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

			const result = this.ts_regions(out, id_n) as TransformResult | null;
			if (result) {
				program.register(result, id_n);
				this.#mark_registered_closures(result);
				out = result.code;
				map = result.map;
				touched = true;
			}

			// Transportable classes: append tag registration for `[ogygia.TRANSPORT]` codecs.
			// Skip ogygia's own source (workspace dev links it outside node_modules; appending
			// an `import 'ogygia'` there would create an eval cycle). Append-only → map survives.
			if (!id_n.startsWith(ctx.pkg_root)) {
				const registered = appendTransportRegistrations(out, id_n, root, path);
				if (registered !== null) {
					out = registered;
					touched = true;
				}
			}
		}

		// CLIENT: rewrite `$app/(state|stores|navigation)` inside island entry components — and
		// every other module in the island graph, `.svelte` or script — to absolute shim paths.
		// Absolute paths bypass Kit's `$app/*` alias entirely: Vite's alias plugin resolves `$app/*`
		// BEFORE this plugin's resolveId can, so the specifier must already be the shim's when the
		// module leaves the transform. Script modules used to be skipped here: a `.ts` helper in an
		// island's closure kept Kit's real client page (never booted under csr=false), and a
		// customer's shared boot helper read `page.data.user` as empty inside every public-page
		// island. (csr=true hosts still pass virtual islands as `__component`.)
		if (
			!ssr &&
			island_graph.has(id_n) &&
			(id_n.endsWith('.svelte') || SCRIPT_MODULE_RE.test(id_n))
		) {
			const rewritten = out.replace(APP_SHIM_IMPORT, (_m: string, _q: string, name: string) =>
				JSON.stringify(ctx.app_shims['$app/' + name])
			);
			if (rewritten !== out) {
				out = rewritten;
				map = null; // import path rewrite invalidates a prior sourcemap
				touched = true;
			}
		}

		// SERVER: stamp the elements Svelte's hydration never walks into (compiler/ownership-stamps.ts),
		// so the runtime's repair, drift watch and morph leave a web component's own light DOM there
		// alone. App components, plus those of packages that declared their compile surface; never the
		// generated glue, and never a `?svelte&type=…` sub-request (not markup).
		if (
			ssr &&
			!id.includes('?') &&
			id_n.endsWith('.svelte') &&
			!is_island_path(bare_v) &&
			(!in_node_modules || ctx.in_declared_pkg(id_n))
		) {
			const stamped = stamp_opaque(out, id_n);
			if (stamped !== null) {
				out = stamped;
				map = null;
				touched = true;
			}
		}

		return touched ? { code: out, map } : null;
	}

	/**
	 * Patch the fn-manifest placeholder in a finished chunk with the collected `og.$` factory
	 * registrations — every transform has run by renderChunk, so `dollar_hoists` is complete. Registrations
	 * go through the globalThis bridge the placeholder module installed (rename-proof under minification).
	 * Returns the patched chunk, or `null` if this chunk carries no placeholder.
	 */
	patch_fn_manifest(code: string): { code: string; map: null } | null {
		if (!code.includes('/*__OGYGIA_FN_MANIFEST__*/')) return null;
		const regs = [...this.dollar_hoists.entries()]
			.map(([tag, src]) => `globalThis.__og_reg_fn(${JSON.stringify(tag)}, (${src}));`)
			.join('\n');
		// FUNCTION-form replacement: factory sources legitimately contain `$$` (a literal `$`
		// before a template hole), which String.replace would collapse in a string replacement.
		return { code: code.replace('/*__OGYGIA_FN_MANIFEST__*/', () => regs), map: null };
	}

	/** True when `file` is a registered island HOST (a component that declares islands). */
	is_registered_host(file: string): boolean {
		const { host_index, registry } = this.program;
		return (
			host_index.has(host_key(file)) ||
			[...registry.values()].some((e) => same_module_path(e.hostPath, file))
		);
	}

	/**
	 * Drop the cached virtual island modules + the registry rows for `file` — call when a HOST changes
	 * (an import-target rename keeps the same island id) or an ENTRY component is deleted (NOT on ordinary
	 * entry-component content edits — those are soft HMR). Mutates the Program; `invalidate` is the
	 * bundler's module-invalidation (Vite's moduleGraph), threaded in. Returns whether anything changed.
	 */
	invalidate_for_file(
		file: string,
		{ deleted = false, invalidate }: { deleted?: boolean; invalidate: (id: string) => void }
	): boolean {
		const { registry, island_graph, by_id, region_kinds, host_index } = this.program;
		const affected = new Set<string>();

		if (this.is_registered_host(file)) {
			for (const vpath of island_vpaths_affected_by_file(file, registry.entries())) {
				affected.add(vpath);
			}
			const prev = host_index.get(host_key(file));
			if (prev) for (const vpath of prev.vpaths) affected.add(vpath);
			// Host re-registers on next transform; clear so emit() can't serve orphans.
			this.program.unregister_host(file);
		}

		if (deleted) {
			for (const [vpath, entry] of [...registry.entries()]) {
				if (!same_module_path(entry.componentPath, file)) continue;
				affected.add(vpath);
				registry.delete(vpath);
				island_graph.delete(vpath);
				by_id.delete(entry.id);
				region_kinds.delete(entry.id);
				const idx = host_index.get(host_key(entry.hostPath ?? ''));
				if (idx) {
					idx.vpaths.delete(vpath);
					idx.ids.delete(entry.id);
				}
			}
		}

		if (affected.size === 0) return false;

		for (const vpath of affected) invalidate(vpath);
		invalidate(RESOLVED(V_SERVER_MANIFEST));
		invalidate(RESOLVED(V_MANIFEST));
		return true;
	}
}
