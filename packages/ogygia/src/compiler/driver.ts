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
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
	transformHost,
	transformTsRegions,
	wrapperVirtualId,
	ISLAND_DIR,
	CLIENT_BINDING_STUB
} from './region/transform.js';
import { routeCsrIsFalse, routeCsrIsTrue, clean_stale_ogygia_dirs } from './standalone.js';
import { run_module_macros } from './macros/pipeline.js';
import { generateRuntimeEntrySource, resolveFeatures } from './link/runtime-entry.js';
import { resolveFoucImportSpec } from './fouc-css.js';
import { moduleHasTransportable, svelteModuleHasTransportable } from './content/transportables.js';
import { rewrite_lake_import_to_placeholder, APP_SHIM_IMPORT } from './region/emit.js';
import { island_deps_module } from './link/island-deps.js';
import {
	secret_module,
	sign_module,
	rate_limit_module,
	session_cookie_module,
	region_ttl_module
} from './link/caps.js';
import { router_config_module } from './link/router-config.js';
import { transport_module, transportables_module } from './link/transport.js';
import { server_manifest_module } from './link/server-manifest.js';
import { manifest_module } from './link/manifest.js';
import { dev_hmr_client_source } from './dev/dev-hmr.js';
import {
	RESOLVED,
	V_RUNTIME_URL,
	V_RUNTIME,
	V_FN_MANIFEST,
	V_RUNTIME_ENTRY,
	V_DEV_HMR,
	V_DEV_HMR_URL,
	V_ISLAND_DEPS,
	V_TRANSPORT,
	V_SECRET,
	V_SIGN,
	V_REQUEST_EVENT,
	V_REGION_ENDPOINT,
	V_RATE_LIMIT,
	V_ROUTER_CONFIG,
	V_SESSION_COOKIE,
	V_REGION_TTL,
	V_SERVER_MANIFEST,
	V_MANIFEST,
	V_TRANSPORTABLES
} from './ids.js';
import { strip_id } from './program.js';
import type { MarkdownOptions } from '../content/markdown/index.js';
import type { Program } from './program.js';
import type { CompileCtx } from './ctx.js';

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
		const link_virtual =
			opts.linkVirtual !== undefined ? opts.linkVirtual : ssr || !routeCsrIsFalse(id, routesDir);
		// Tri-state route csr, threaded into the transform (see transformHost's routeCsr branch):
		//   true  → csr=true route host: ogygia steps aside (strip islands, inject `true` marker).
		//   false → csr=false route host: keep islands, inject the csr-false RESET marker (an
		//           option-less csr=true ANCESTOR layout would otherwise leak `true` down the context
		//           and silently degrade every island in the csr=false subtree to inline).
		//   undefined → not a route host (shared lib component): no marker; its csr depends on the
		//           page that renders it, so it keeps its islands.
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
					(entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) &&
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
		{ const __ps = P ? performance.now() : 0; walk(src_dir); if (P) prof.prescanMs += performance.now() - __ps; }

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
				const src = ctx.read_file(norm);
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
		program.runtime_feature_hash = crypto
			.createHash('sha256')
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
			const url = is_dev ? '/@id/__x00__' + V_RUNTIME : hashedRuntimeUrl || this.runtime_chunk_url();
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
				src = src.replace(
					APP_SHIM_IMPORT,
					(_m: string, _q: string, name: string) => JSON.stringify(ctx.app_shims['$app/' + name])
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
}
