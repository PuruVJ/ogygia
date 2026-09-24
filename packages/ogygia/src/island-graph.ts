/**
 * THE ISLAND GRAPH — which chunks each island's code needs, as DATA the page carries, never as
 * `<link rel="modulepreload">` tags.
 *
 * An island entry's own `import()` finds its chunks only after it downloads and parses: a waterfall.
 * A modulepreload per chunk removes the waterfall, but a hint in the HTML fetches the moment the
 * parser meets it — before the page has painted, and for islands that may never wake. So the server
 * writes the graph as data (this format), and the runtime inserts the preload links itself when an
 * island WAKES (runtime/island-graph-preload.ts): after the wake gate, for exactly that island, beside
 * its `import()`. Its whole graph downloads in parallel the moment it may start; nothing lands in
 * the paint window; an island that never wakes downloads nothing.
 *
 * Wire shape (one inert JSON script): `{"h":[href,…],"e":{"<entry>":[i,…]}}` — every chunk href
 * once, each entry (the region's `entry` attribute, as emitted) listing the indexes of the chunks
 * it needs. Twenty islands sharing Svelte's client runtime name its chunk once.
 *
 * Universal leaf: the server encodes (server/document-tail.ts), the boot decodes.
 */

/** The attribute that marks a graph script (the runtime finds every one on the page by it). */
export const ISLAND_GRAPH_ATTR = 'data-ogygia-graph';

/** The JSON shape a graph script carries. */
export interface IslandGraphWire {
	h: string[];
	e: Record<string, number[]>;
}

/** Encode entry → chunk hrefs as the wire shape (JSON text, not yet script-escaped). */
export function encode_island_graph(graph: ReadonlyMap<string, readonly string[]>): string {
	const h: string[] = [];
	const index = new Map<string, number>();
	const e: Record<string, number[]> = {};
	for (const [entry, hrefs] of graph) {
		const ids: number[] = [];
		for (const href of hrefs) {
			let i = index.get(href);
			if (i === undefined) {
				i = h.length;
				h.push(href);
				index.set(href, i);
			}
			ids.push(i);
		}
		e[entry] = ids;
	}
	return JSON.stringify({ h, e } satisfies IslandGraphWire);
}

/** Decode a graph script's text: entry → chunk hrefs, as written (unresolved). Malformed → empty. */
export function decode_island_graph(text: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let wire: IslandGraphWire;
	try {
		wire = JSON.parse(text) as IslandGraphWire;
	} catch {
		return out;
	}
	if (!wire || !Array.isArray(wire.h) || !wire.e || typeof wire.e !== 'object') return out;
	for (const entry of Object.keys(wire.e)) {
		const ids = wire.e[entry];
		if (!Array.isArray(ids)) continue;
		const hrefs: string[] = [];
		for (const i of ids) {
			const href = wire.h[i];
			if (typeof href === 'string') hrefs.push(href);
		}
		out.set(entry, hrefs);
	}
	return out;
}
