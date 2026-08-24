/**
 * The `Compiler` — the driver / long-lived compile session. It holds the `Program` (cross-file
 * linker), the resolved `CompileCtx`, and the per-file transform cache, and exposes the file-local
 * front-end as one call: `transform(source, id)` → parse ▸ analyze ▸ lower ▸ emit (today fused inside
 * `transformHost`), memoized. It is bundler-agnostic by construction — it imports no Vite; the adapter
 * drives it. That independence is the design goal: a future REPL is just a second adapter over the
 * same driver, feeding a `CompileCtx` + source and rendering the returned artifacts.
 *
 * The transform cache is content-keyed (`hit.code === source`), so a changed source misses and
 * recomputes on its own; the linker's `unregister_host` deliberately does NOT clear it.
 */
import { fs, path, createHash } from './host.js';
// `performance` is a global in both Node (≥16) and the browser — no import, so the driver graph loads
// in the browser compiler (Observatory REPL) without pulling node:perf_hooks.
const performance = globalThis.performance;
import {
	transformHost,
	transformTsRegions,
	wrapperVirtualId,
	ISLAND_DIR,
	is_island_path,
	islandChunkFileName,
	CLIENT_BINDING_STUB
} from './region/transform.js';
import { routeCsrIsFalse, routeCsrIsTrue, hasAnyCsrTrueRoute, clean_stale_ogygia_dirs } from './kit.js';
import { run_module_macros } from './macros/pipeline.js';
import { generateRuntimeEntrySource, resolveFeatures } from './link/runtime-entry.js';
import { resolveFoucImportSpec, FOUC_CSS_PREFIX, FOUC_SCOPED_PREFIX } from './fouc-css.js';
import {
	moduleHasTransportable,
	svelteModuleHasTransportable,
	appendSvelteModuleRegistrations,
	appendTransportRegistrations
} from './content/transportables.js';
import { rewrite_loaders } from './content/loaders.js';
import { rewrite_regions } from './content/regions.js';
import { materialize } from './content/git.js';
import { rewrite_lake_import_to_placeholder, APP_SHIM_IMPORT } from './region/emit.js';
import { island_deps_module } from './link/island-deps.js';
import {
	secret_module,
	sign_module,
	rate_limit_module,
	session_cookie_module,
	region_ttl_module,
	route_csr_module
} from './link/caps.js';
import { router_config_module } from './link/router-config.js';
import { transport_module, transportables_module } from './link/transport.js';
import { server_manifest_module } from './link/server-manifest.js';
import { manifest_module } from './link/manifest.js';
import { dev_hmr_client_source } from './dev/dev-hmr.js';
import { same_module_path, island_vpaths_affected_by_file } from './dev/hmr.js';
import {
	RESOLVED,
	V_RUNTIME_URL,
	V_RUNTIME,
	V_FN_MANIFEST,
	V_RUNTIME_ENTRY,
	V_DEV_HMR,
	V_DEV_HMR_URL,
	V_DEVTOOLS_BOOT,
	V_DEVTOOLS_BOOT_URL,
	V_ISLAND_DEPS,
	V_TRANSPORT,
	V_SECRET,
	V_SIGN,
	V_REQUEST_EVENT,
	V_ROUTE_CSR,
	V_REGION_ENDPOINT,
	V_RATE_LIMIT,
	V_ROUTER_CONFIG,
	V_SESSION_COOKIE,
	V_REGION_TTL,
	V_SERVER_MANIFEST,
	V_MANIFEST,
	V_TRANSPORTABLES
} from './ids.js';
import { strip_id, host_key } from './program.js';
import type { MarkdownOptions } from '../content/markdown/index.js';
import type { Program, RegisterResult } from './program.js';
import type { CompileCtx } from './ctx.js';

/** A file-local transform result: the Vite `{ code, map }` plus the descriptors the linker registers. */
type TransformResult = RegisterResult & { code: string; map: unknown };

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

const fnv = (str: string) => {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
};

export class Compiler {
	readonly program: Program;
	readonly transform_cache = new Map<string, { code: string; result: unknown }>();
	readonly profiler: Profiler;
	/** Every `import.meta.og.$` hoist collected across the build (tag → factory source). Filled by
	 *  `macros()`; drained by the adapter's fn-manifest emit (dev load leg, renderChunk, writeBundle). */
	readonly dollar_hoists = new Map<string, string>();
	/** `prescan()` is once-per-session — guarded so the adapter can call it from any hook. */
	#scanned = false;
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
				/\.(svelte|js|ts)$/,
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
	 * `(id, linkVirtual, routeCsr)` triple, content-gated on the source.
	 */
	transform(source: string, id: string, opts: { ssr?: boolean; linkVirtual?: boolean } = {}) {
		const ctx = this.#ctx!;
		const { prof, P, outHash } = this.profiler;
		const ssr = opts.ssr !== false;
		// Scale: csr=false CLIENT hosts must not statically import portable wrappers (or the
		// hydrate entries those wrappers pull in). Kit still emits those page nodes; sharing
		// the emitFile module with the page graph forces Rolldown thin `og-region.*`
		// facades. SSR keeps real wrappers for HTML; csr=true client keeps them so Kit can
		// hydrate islands as normal components. Hydration always uses `import(entry)`.
		const routesDir = path.join(ctx.root, 'src', 'routes');
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
		const cache_key = `${id}\0${link_virtual ? '1' : '0'}\0${route_csr === true ? 't' : route_csr === false ? 'f' : 'n'}`;
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
			visibleMargin: ctx.visibleMargin,
			presets: ctx.presets,
			importKeys: ctx.import_keys,
			idSalt: ctx.id_salt,
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
			importKeys: ctx.import_keys,
			idSalt: ctx.id_salt
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
				} else if (entry.name.endsWith('.svelte')) {
					const src = ctx.read_file(full);
					if (src == null) continue;
					// A `<script module>` transportable class goes in the manifest too (keyed by the
					// .svelte path — side-effect-importing the component runs its module registration).
					if (svelteModuleHasTransportable(src, full)) transportable_modules.add(full);
					const result = this.transform(src, full);
					if (result) program.register(result, full);
				} else if (
					(entry.name.endsWith('.ts') ||
						entry.name.endsWith('.js') ||
						entry.name.endsWith('.mjs')) &&
					!entry.name.endsWith('.d.ts')
				) {
					// `.ts` / `.js` region mints (load / remote functions). Discover them up front so a
					// deferred region's server-manifest entry exists before the endpoint is ever hit —
					// lazy transform order would otherwise leave the id missing (403 on first fetch).
					const src = ctx.read_file(full);
					if (src == null) continue;
					// Transportable classes go into the eager-registration manifest so an island
					// receiving one as a prop never has to import the class itself.
					if (moduleHasTransportable(src, full)) transportable_modules.add(full);
					const result = this.ts_regions(src, full);
					if (result) program.register(result, full);
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
			for (const extra of ctx.extra_scan_roots) walk(extra);
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
		// PERF: strictly O(reachable modules). A SINGLE shared `seen` set means each file is read and
		// scanned exactly once and never re-descended — no per-root re-walk, no depth multiplier (cf.
		// the depth-25 O(2^depth) usage-walk regression this deliberately avoids). A cheap regex lists
		// specifiers (over-collection is harmless — an unresolvable one is skipped); package/alias
		// specifiers stop the walk, where the lazy resolveId marking below stays as the backstop.
		{
			const __ws = P ? performance.now() : 0;
			const seen_dep = new Set<string>();
			const DEP_EXTS = ['', '.svelte', '.ts', '.js', '.svelte.ts', '.svelte.js', '.mjs'];
			const resolve_dep = (spec: string, importerAbs: string): string | null => {
				const base = resolveFoucImportSpec(spec, importerAbs, libDir);
				if (!base) return null; // package / alias — the lazy resolveId marking is the backstop
				for (const ext of DEP_EXTS) {
					try {
						if (fs.statSync(base + ext).isFile()) return base + ext;
					} catch {
						/* not this ext */
					}
				}
				for (const ext of DEP_EXTS.slice(1)) {
					const idx = path.join(base, 'index' + ext);
					try {
						if (fs.statSync(idx).isFile()) return idx;
					} catch {
						/* not an index */
					}
				}
				return null;
			};
			const IMPORT_SPEC =
				/\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]/g;
			const walk_dep = (abs: string) => {
				const norm = strip_id(abs);
				if (seen_dep.has(norm)) return;
				seen_dep.add(norm);
				island_graph.add(norm);
				if (!/\.(svelte|ts|js|mjs|cjs)$/.test(norm)) return;
				const src = ctx.read_file(norm);
				if (src == null) return;
				IMPORT_SPEC.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = IMPORT_SPEC.exec(src))) {
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
					if (dep) walk_dep(dep);
				}
			};
			for (const entry of registry.values()) {
				if (entry.componentPath) walk_dep(strip_id(entry.componentPath));
			}
			if (P) prof.prescanMs += performance.now() - __ws;
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

	/** The feature-selected runtime chunk name (immutable-cached). Needs prescan to have run for a
	 *  non-empty feature hash; both build legs prescan the same source → the same name. */
	runtime_chunk_filename(): string {
		return this.#ctx!.runtime_chunk_filename(this.program.runtime_feature_hash);
	}

	/** Public URL of the runtime chunk (`'/' + runtime_chunk_filename()`). */
	runtime_chunk_url(): string {
		return '/' + this.runtime_chunk_filename();
	}

	/**
	 * Client-build chunk emit (via the injected `emitFile`): the feature-selected runtime entry (when
	 * `emitRuntime`), then one deterministic chunk per deduped HYDRATE region id — a stable filename so
	 * SSR can bake `entry` without a client→server hash handoff; csr=false hosts omit wrapper imports so
	 * this emit owns the module. N instances of a region → still one entry URL. Idempotent per id.
	 */
	emit_build_chunks(
		emitFile: (chunk: { type: 'chunk'; id: string; fileName: string }) => void,
		{ emitRuntime }: { emitRuntime: boolean }
	): void {
		if (emitRuntime) {
			// Unresolved virtual id — resolve_id/emit synthesize the feature-selected entry.
			emitFile({ type: 'chunk', id: V_RUNTIME_ENTRY, fileName: this.runtime_chunk_filename() });
		}
		const { region_kinds, by_id, emitted_island_chunks } = this.program;
		for (const [rid, kind] of region_kinds) {
			if (kind !== 'hydrate') continue;
			const virtualPath = by_id.get(rid);
			if (!virtualPath) continue;
			if (emitted_island_chunks.has(rid)) continue;
			emitted_island_chunks.add(rid);
			emitFile({ type: 'chunk', id: virtualPath, fileName: islandChunkFileName(rid) });
		}
	}

	/**
	 * Emit one ogygia VIRTUAL module's source: the config/capability virtuals (secret / sign / rate-limit
	 * / router / session / ttl / manifests / runtime entry+url / transport / dev-hmr / request-event /
	 * region-endpoint), and the registered island/region sources (with the client leg's `$app/*`-shim +
	 * lake-placeholder rewrites). Returns the source string, or `null` if `id` is not an ogygia virtual —
	 * the adapter owns only the FOUC-css virtuals (they carry a Vite `moduleType`) and the two Vite build
	 * values threaded in here (`hashedRuntimeUrl` from the client-leg handoff, `universalHooks` path).
	 */
	emit(
		id: string,
		{
			ssr,
			hashedRuntimeUrl,
			universalHooks
		}: { ssr: boolean; hashedRuntimeUrl: string | null; universalHooks: string | null }
	): string | null {
		const ctx = this.#ctx!;
		const program = this.program;
		const is_dev = ctx.is_dev;

		if (id === RESOLVED(V_RUNTIME_URL)) {
			// dev: the vite dev URL. build: the CONTENT-HASHED runtime URL — from this
			// instance (standalone) or the handoff file the client build wrote (Kit-driven);
			// fall back to the fixed name only if the handoff is somehow missing.
			// Ensure prescan ran so `runtime_feature_hash` matches the client emit's filename (both
			// legs prescan the same source → same feature set → same name).
			if (!is_dev) this.prescan();
			const url = is_dev
				? '/@id/__x00__' + V_RUNTIME
				: hashedRuntimeUrl || this.runtime_chunk_url();
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
		if (id === RESOLVED(V_DEVTOOLS_BOOT)) {
			// Standalone dock boot for csr=true (Kit-owned) pages: the ogygia runtime never boots
			// there, so mount ONLY the dock — no router/region features (Kit owns navigation). The
			// dock renders a "csr=true here — open a csr=false page" notice, since a Kit-hydrated page
			// has no ogygia islands to inspect. Empty when devtools is off (never injected then).
			if (!ctx.devtools) return `export {}`;
			const ui_path = `${ctx.runtime_dir}/../devtools/ui.js`.replace(/\\/g, '/');
			return (
				`import { install_devtools_ui } from ${JSON.stringify(ui_path)};\n` +
				`install_devtools_ui({ csr_true: true });\n`
			);
		}
		if (id === RESOLVED(V_DEVTOOLS_BOOT_URL)) {
			// The served URL the handle injects on csr=true pages. Empty in build/preview and when
			// devtools is off; the vite-dev `/@id/` URL otherwise. Dev-only, matching how apps enable
			// devtools for `vite dev` alone (`devtools: command === 'serve'`).
			if (!ctx.devtools || !is_dev) return `export default '';`;
			return `export default ${JSON.stringify('/@id/__x00__' + V_DEVTOOLS_BOOT)};`;
		}
		if (id === RESOLVED(V_ISLAND_DEPS)) {
			return island_deps_module(ssr, is_dev);
		}
		if (id === RESOLVED(V_TRANSPORT)) {
			return transport_module(universalHooks);
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
					`export function known_region_fps() { return new Set(); }`
				);
			}
			return `export { makeRegionEndpoint, mintServerIsland, known_region_fps } from ${JSON.stringify(ctx.region_endpoint_module)};`;
		}
		if (id === RESOLVED(V_RATE_LIMIT)) {
			return rate_limit_module(ssr, ctx.rate_limit);
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
			return route_csr_module(ssr, path.join(ctx.root, 'src', 'routes'));
		}
		if (id === RESOLVED(V_SERVER_MANIFEST)) {
			// Populated in BOTH dev and build (unlike the client manifest, which dev fills from URLs).
			if (ssr) this.prescan();
			return server_manifest_module(ssr, program, is_dev, (vp: string) => ctx.dev_url_for(vp));
		}
		if (id === RESOLVED(V_MANIFEST)) {
			return manifest_module(is_dev);
		}
		if (id === RESOLVED(V_TRANSPORTABLES)) {
			// Eager-registration manifest of transportable-class modules (prescan-discovered).
			this.prescan();
			return transportables_module(program.transportable_modules);
		}
		const srcEntry = program.registry.get(id);
		if (srcEntry && srcEntry.role === 'region') {
			// Leg-split: SSR gets the signer-carrying descriptor, client gets metadata only.
			return ssr ? srcEntry.ssrSource! : srcEntry.clientSource!;
		}
		if (srcEntry) {
			let src = srcEntry.source!;
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
		if (source === V_DEV_HMR) return RESOLVED(V_DEV_HMR);
		if (source === V_DEV_HMR_URL) return RESOLVED(V_DEV_HMR_URL);
		if (source === V_DEVTOOLS_BOOT) return RESOLVED(V_DEVTOOLS_BOOT);
		if (source === V_DEVTOOLS_BOOT_URL) return RESOLVED(V_DEVTOOLS_BOOT_URL);
		if (source === V_ISLAND_DEPS) return RESOLVED(V_ISLAND_DEPS);
		if (source === V_SECRET) return RESOLVED(V_SECRET);
		if (source === V_SIGN) return RESOLVED(V_SIGN);
		if (source === V_RATE_LIMIT) return RESOLVED(V_RATE_LIMIT);
		if (source === V_ROUTER_CONFIG) return RESOLVED(V_ROUTER_CONFIG);
		if (source === V_SESSION_COOKIE) return RESOLVED(V_SESSION_COOKIE);
		if (source === V_REGION_TTL) return RESOLVED(V_REGION_TTL);
		if (source === V_ROUTE_CSR) return RESOLVED(V_ROUTE_CSR);
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
		const defines_collection = source.includes('ogygia/content') && /\bcontent\s*\(/.test(source);
		const defines_loader = source.includes('import.meta.og.loader.');
		if (!defines_collection && !defines_loader) return;
		const server_only =
			/\.(server|remote)\.(ts|js|mjs)$/.test(bare) ||
			/\/(src\/lib\/server|server)\//.test(bare.slice(root.length));
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
			emitFile: (chunk: { type: 'chunk'; id: string; fileName: string }) => void;
		}
	): Promise<{ code: string; map: unknown } | null> {
		const ctx = this.#ctx!;
		const program = this.program;
		const { registry, island_graph, emitted_island_chunks } = program;
		const root = ctx.root;

		// Discover islands before any module is transformed so island_graph is populated
		// even when an island entry component is processed before its host page.
		this.prescan();

		const id_n = strip_id(id);

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
			const m = /[?&]og_preset=([\w-]+)/.exec(id);
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
			(!is_island_path(bare_v) || portable_entry) &&
			(!in_node_modules || ctx.has_island_hint(code))
		) {
			// Pass Vite's ssr flag through — client csr=false hosts omit wrapper links.
			// `out`, NOT `code`: the wire/code/md/bake rewrites above already landed in `out`, and
			// the island transform's result REPLACES it — feeding it `code` would silently discard
			// them for any component the host transform touches (import.meta.og.code in a .svelte
			// stayed un-rewritten and exploded at runtime as `undefined.code`).
			const result = this.transform(out, id_n, { ssr }) as TransformResult | null;
			if (result) {
				program.register(result, id_n);
				out = result.code;
				map = result.map;
				touched = true;

				// Emit the deterministic island chunk for any hydrate island discovered HERE that the
				// buildStart prescan couldn't see — i.e. declared inside a library component (host
				// outside the app's `src`). Without this the client leg lets Rolldown content-hash the
				// entry, diverging from the deterministic name SSR baked into `<ogygia-region entry>`.
				if (ctx.is_build && !ssr) {
					for (const isl of result.islands ?? []) {
						const kind = isl.kind ?? (isl.server ? 'defer' : 'hydrate');
						if (kind !== 'hydrate' || !isl.virtualPath || emitted_island_chunks.has(isl.id))
							continue;
						emitted_island_chunks.add(isl.id);
						emitFile({ type: 'chunk', id: isl.virtualPath, fileName: islandChunkFileName(isl.id) });
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
		if (
			(id_n.endsWith('.ts') || id_n.endsWith('.js') || id_n.endsWith('.mjs')) &&
			!id_n.includes('/node_modules/') &&
			!is_island_path(id_n)
		) {
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

		// CLIENT: rewrite `$app/(state|stores|navigation)` inside island entry components
		// (and any other island_graph .svelte) to absolute shim paths. Absolute paths bypass
		// Kit's `$app/*` alias entirely — needed when an island's own component graph imports
		// `$app/*` (csr=true hosts still pass virtual islands as `__component`).
		if (!ssr && island_graph.has(id_n) && id_n.endsWith('.svelte')) {
			const rewritten = out.replace(APP_SHIM_IMPORT, (_m: string, _q: string, name: string) =>
				JSON.stringify(ctx.app_shims['$app/' + name])
			);
			if (rewritten !== out) {
				out = rewritten;
				map = null; // import path rewrite invalidates a prior sourcemap
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
