/**
 * Dev-only per-island byte estimate — walks DOWN the Vite dev module graph from each island entry
 * and sums the served (transformed) size of the APP modules it transitively imports: its wrapper,
 * the component, and every child component / app util the component pulls in. Not just the wrapper
 * chunk a `PerformanceResourceTiming` lookup sees — but also NOT the shared framework.
 *
 * The framework boundary is pruned (`node_modules`, Vite's `.vite/deps` prebundles): Svelte's runtime
 * is loaded ONCE for the whole page, so folding it into every island makes them all read as ~2 MB and
 * hides the real difference. Counting only app code surfaces the number that actually varies island to
 * island — "what does THIS component cost on top of the shared runtime".
 *
 * Caveats (surfaced in the tab): dev code is unbundled + unminified, so the number is an ESTIMATE of
 * relative cost, not the shipped byte count; and a still-cold island (one that hasn't woken, so its
 * component was never loaded) has no subgraph in the graph yet — it simply doesn't appear here until
 * it wakes. Pure over the nodes it's handed; reads, never mutates.
 */

/** Structural shape of a Vite dev module-graph node (the fields the byte walk reads). */
export type ByteGraphModule = {
	url?: string | null;
	id?: string | null;
	file?: string | null;
	transformResult?: { code?: string | null } | null;
	importedModules?: Iterable<ByteGraphModule>;
};

/** An island entry module — `virtual:ogygia/island/<id>.js` (dev url carries the id). */
const ISLAND_RE = /virtual:ogygia\/island\/([0-9a-f]+)\.js/;

/** Shared framework / prebundled deps — pruned so per-island totals reflect app code, not Svelte. */
function is_framework(mod: ByteGraphModule): boolean {
	const s = (mod.file || '') + '\n' + (mod.url || mod.id || '');
	const u = mod.url || mod.id || '';
	return (
		s.includes('node_modules') ||
		s.includes('/.vite/deps/') ||
		// the ogygia package runtime — its modules resolve to `packages/ogygia/src` in dev and
		// `.../ogygia/dist` in prod; both are shared once per page, not part of an island's cost.
		/[\\/]ogygia[\\/](src|dist)[\\/]/.test(s) ||
		// SHARED ogygia registries — `virtual:ogygia/transportables` (every wire/store class app-wide),
		// `.../transport`, `.../fn-manifest`, the manifests. One island importing the transportable
		// registry would otherwise drag in EVERY transportable-defining module (the whole app). These
		// load once per page. The island's own entry (`virtual:ogygia/island/…`) is the ONE exception —
		// it's the door to the component, so it stays traversable (see `is_glue`).
		(u.includes('virtual:ogygia/') && !u.includes('virtual:ogygia/island/'))
	);
}

/**
 * The island's own entry glue (`virtual:ogygia/island/<id>.js`, its wrapper). Traversed THROUGH to
 * reach the real component, but not COUNTED — it's the island's door, not the component's weight.
 */
function is_glue(mod: ByteGraphModule): boolean {
	return (mod.url || mod.id || '').includes('virtual:ogygia/island/');
}

/**
 * `island id → { bytes, modules }` for every island entry present in the graph, where `bytes` is the
 * summed served size of the entry's whole transitive import subgraph and `modules` the node count.
 * When two graph nodes resolve to the same island id (e.g. `?v=` query variants), the larger wins.
 */
export function island_subgraph_bytes(
	modules: Iterable<ByteGraphModule>
): Record<string, { bytes: number; modules: number }> {
	const out: Record<string, { bytes: number; modules: number }> = {};
	for (const mod of modules) {
		const url = mod.url || mod.id || '';
		const m = ISLAND_RE.exec(url);
		if (!m) continue;
		const iid = m[1];
		const seen = new Set<ByteGraphModule>();
		const stack: ByteGraphModule[] = [mod];
		let bytes = 0;
		let count = 0;
		let steps = 0;
		while (stack.length && steps++ < 20000) {
			const n = stack.pop()!;
			if (seen.has(n)) continue;
			seen.add(n);
			// Prune at the framework boundary — don't count Svelte/ogygia runtime/registries, and don't
			// descend into their large subgraphs (keeps the number app-focused and the walk cheap).
			if (is_framework(n)) continue;
			// Traverse into everything else (incl. the island's own entry glue) to reach the component...
			for (const dep of n.importedModules ?? []) stack.push(dep);
			// ...but count only the app modules — the component + its child components / utils.
			if (is_glue(n)) continue;
			const code = n.transformResult?.code;
			if (typeof code === 'string') {
				bytes += code.length;
				count++;
			}
		}
		if (count > 0 && (!out[iid] || out[iid].bytes < bytes)) out[iid] = { bytes, modules: count };
	}
	return out;
}
