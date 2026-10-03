/**
 * The byte ledger's DOM side: the page's island graph (`script[data-ogygia-graph]`, a build writes
 * it), the browser's size of every file it loaded, the regions on the page and the runtime's files
 * — handed to the pure `byte_ledger` (bytes.ts). Null off a build (the dev server writes no graph).
 * Shared by the Bytes tab and an island's detail card.
 */
import { ISLAND_GRAPH_ATTR, decode_island_graph } from '../island-graph.js';
import { byte_ledger, type Ledger } from './bytes.js';
import { dynamic_imports, static_imports } from '../profiler/page-assets.js';
import { all_regions, region_name } from './regions.js';

const abs = (href: string | null | undefined): string | null => {
	if (!href) return null;
	try {
		return new URL(href, location.href).href;
	} catch {
		return null;
	}
};

/**
 * THE RUNTIME'S OWN PARTS: the ogygia runtime loads its later steps itself (`import()` of its own
 * chunks as islands wake: hydration and the rest), so no island graph names them. Read once from the
 * runtime's file (the browser's cache has it): its dynamic imports and what each imports, every file
 * once. The devtools' own dock is one of those imports in a devtools build: a root whose imports
 * reach this very file is the dock's, left out with what only it imports (not by when it loaded: a
 * dock that reopens on its own loads before the runtime's parts). Null until read; the Bytes tab's
 * next tick has them.
 */
interface RuntimeParts {
	/** each part (a dynamic import of the runtime) with what it imports: counted only when the part
	 *  itself loaded — a part that never ran shares files with the dock, which loaded them */
	roots: Map<string, Set<string>>;
	/** the dock's roots (left out) */
	dock: string[];
}
let parts: { src: string; read: RuntimeParts | null } | null = null;
/** globals only the devtools' own code sets (the runtime sets none: it publishes `__ogygia_devtools`
 *  alone, from its own chunk, never a root) — a part carrying one is the devtools', not the page's */
const DOCK_MARKS = ['__ogygia_session', '__ogygia_testing', '__ogygia_region_bytes', '__ogygia_region_names', '__ogygia_styles', '__ogygia_devtools_meta'];
function runtime_parts(src: string): RuntimeParts | null {
	if (parts?.src !== src) {
		parts = { src, read: null };
		void read_parts(src).then((read) => {
			if (parts?.src === src) parts.read = read;
		});
	}
	return parts.read;
}
async function read_parts(src: string): Promise<RuntimeParts> {
	const cache = new Map<string, Promise<string>>();
	const text = (u: string): Promise<string> => {
		let t = cache.get(u);
		if (!t) {
			t = fetch(u, { cache: 'force-cache' })
				.then((r) => (r.ok ? r.text() : ''))
				.catch(() => '');
			cache.set(u, t);
		}
		return t;
	};
	const self = import.meta.url;
	const roots = new Map<string, Set<string>>();
	const dock: string[] = [];
	for (const spec of dynamic_imports(await text(src))) {
		const root = abs_from(spec, src);
		if (!root || roots.has(root) || dock.includes(root)) continue;
		// this root's own closure (its static imports to the end)
		const closure = new Set<string>([root]);
		const queue = [root];
		let docked = false;
		while (queue.length && closure.size < 300) {
			const at = queue.shift()!;
			const body = await text(at);
			if (!docked && DOCK_MARKS.some((m) => body.includes(m))) docked = true;
			for (const s of static_imports(body)) {
				const u = abs_from(s, at);
				if (u && !closure.has(u)) closure.add(u), queue.push(u);
			}
		}
		// (the dock: it reaches this file, or carries what only the dock sets — its entry loads its tabs,
		// this one among them, lazily)
		if (docked || closure.has(self)) dock.push(root);
		else roots.set(root, closure);
	}
	return { roots, dock };
}
const abs_from = (spec: string, base: string): string | null => {
	try {
		return new URL(spec, base).href;
	} catch {
		return null;
	}
};

export function page_ledger(): Ledger | null {
	if (typeof document === 'undefined') return null;
	const graph = new Map<string, string[]>();
	for (const s of document.querySelectorAll(`script[${ISLAND_GRAPH_ATTR}]`))
		for (const [entry, hrefs] of decode_island_graph(s.textContent ?? '')) {
			const key = abs(entry);
			if (key && !graph.has(key)) graph.set(key, hrefs.map(abs).filter((x): x is string => !!x));
		}
	if (!graph.size) return null;
	const sizes = new Map<string, { wire: number; raw: number }>();
	for (const r of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
		const wire = r.encodedBodySize || r.transferSize || r.decodedBodySize || 0;
		sizes.set(r.name, { wire, raw: r.decodedBodySize || wire });
	}
	const islands = new Map<string, { entry: string; file?: string; name: string; kind: string; wake: string; count: number }>();
	for (const r of all_regions()) {
		const entry = abs(r.entry);
		if (!entry) continue;
		const g = islands.get(entry);
		// (its own file is its location, the one the browser loaded and sized)
		const file = abs(r.src);
		if (g) g.count++;
		else islands.set(entry, { entry, ...(file ? { file } : {}), name: region_name(r.entry), kind: r.kind, wake: r.wake, count: 1 });
	}
	const runtime_src = abs(document.querySelector('script[data-ogygia-runtime]')?.getAttribute('src'));
	const runtime = [
		runtime_src,
		...[...document.querySelectorAll('link[data-ogygia-runtime-dep]')].map((l) => abs(l.getAttribute('href')))
	].filter((x): x is string => !!x);
	// …and its own parts the browser loaded (an island's file is the island's, whoever imports it)
	const rp = runtime_src ? runtime_parts(runtime_src) : null;
	if (rp) {
		const island_files = new Set<string>();
		for (const list of graph.values()) for (const u of list) island_files.add(u);
		for (const i of islands.values()) island_files.add(i.file ?? i.entry);
		for (const [root, closure] of rp.roots)
			if (sizes.has(root)) for (const u of closure) if (sizes.has(u) && !island_files.has(u) && !runtime.includes(u)) runtime.push(u);
	}
	return byte_ledger([...islands.values()], graph, (u) => sizes.get(u) ?? null, runtime);
}

/** One island's line of the ledger (by its entry), and the islands it shares code with. */
export function island_ledger(entry: string | null | undefined): { row: Ledger['rows'][number]; shares_with: string[] } | null {
	const l = page_ledger();
	const key = abs(entry);
	if (!l || !key) return null;
	const row = l.rows.find((r) => r.entry === key);
	if (!row) return null;
	const with_ = new Set<string>();
	for (const s of l.shared) if (s.users.includes(row.name)) for (const u of s.users) if (u !== row.name) with_.add(u);
	return { row, shares_with: [...with_] };
}
