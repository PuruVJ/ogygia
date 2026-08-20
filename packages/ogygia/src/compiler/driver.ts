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
import { performance } from 'node:perf_hooks';
import { transformHost, wrapperVirtualId, CLIENT_BINDING_STUB } from './transform.js';
import { routeCsrIsFalse, routeCsrIsTrue } from './standalone.js';
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
}
