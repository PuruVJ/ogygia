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
import { resolveFeatures } from './link/runtime-entry.js';
import { resolveFoucImportSpec } from './fouc-css.js';
import { moduleHasTransportable, svelteModuleHasTransportable } from './content/transportables.js';
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
}
