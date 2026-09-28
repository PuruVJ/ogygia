/**
 * The byte ledger's DOM side: the page's island graph (`script[data-ogygia-graph]`, a build writes
 * it), the browser's size of every file it loaded, the regions on the page and the runtime's files
 * — handed to the pure `byte_ledger` (bytes.ts). Null off a build (the dev server writes no graph).
 * Shared by the Bytes tab and an island's detail card.
 */
import { ISLAND_GRAPH_ATTR, decode_island_graph } from '../island-graph.js';
import { byte_ledger, type Ledger } from './bytes.js';
import { all_regions, region_name } from './regions.js';

const abs = (href: string | null | undefined): string | null => {
	if (!href) return null;
	try {
		return new URL(href, location.href).href;
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
	const islands = new Map<string, { entry: string; name: string; kind: string; wake: string; count: number }>();
	for (const r of all_regions()) {
		const entry = abs(r.entry);
		if (!entry) continue;
		const g = islands.get(entry);
		if (g) g.count++;
		else islands.set(entry, { entry, name: region_name(r.entry), kind: r.kind, wake: r.wake, count: 1 });
	}
	const runtime = [
		document.querySelector('script[data-ogygia-runtime]')?.getAttribute('src'),
		...[...document.querySelectorAll('link[data-ogygia-runtime-dep]')].map((l) => l.getAttribute('href'))
	]
		.map(abs)
		.filter((x): x is string => !!x);
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
