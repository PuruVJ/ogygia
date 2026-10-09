/**
 * THE ISLAND GRAPH OF A HOLE'S ANSWER. An island inside a hole's answer writes its graph (the chunks
 * its code needs — island-graph.ts) into the render's head, and the endpoint ships only the body, so
 * the islands a hole brings loaded in a waterfall: each chunk discovered only after the last one
 * parsed (+1.1 s at a 150 ms round trip, measured). This carries the head's graph scripts over into
 * the answer as one script. Its URLs are made root-absolute against the endpoint's request: the answer
 * lands in a page at any depth, and a `./_app/…` resolved there would 404. The runtime reads any
 * graph script in the document (runtime/island-graph-preload.ts), so a nested island's wake then
 * preloads its whole graph at once, as on the page itself. indexOf only.
 */
import { ISLAND_GRAPH_ATTR, decode_island_graph, decode_island_locations } from '../island-graph.js';
import { island_graph_script } from './document-tail.js';

function root_absolute(value: string, base: URL): string {
	if (!value.startsWith('./') && !value.startsWith('../')) return value;
	try {
		const u = new URL(value, base);
		return u.origin === base.origin ? u.pathname + u.search + u.hash : value;
	} catch {
		return value;
	}
}

/** One graph script for the answer (or '' when the render's head carries none). */
export function hole_graph_script(head: string, base: URL): string {
	let at = head.indexOf(ISLAND_GRAPH_ATTR);
	if (at === -1) return '';
	const graph = new Map<string, string[]>();
	const locations = new Map<string, string>();
	for (; at !== -1; at = head.indexOf(ISLAND_GRAPH_ATTR, at + ISLAND_GRAPH_ATTR.length)) {
		const open = head.indexOf('>', at);
		const close = open === -1 ? -1 : head.indexOf('</script', open);
		if (close === -1) break;
		const text = head.slice(open + 1, close);
		for (const [entry, hrefs] of decode_island_graph(text)) {
			const key = root_absolute(entry, base);
			if (!graph.has(key)) graph.set(key, hrefs.map((h) => root_absolute(h, base)));
		}
		for (const [entry, src] of decode_island_locations(text)) locations.set(root_absolute(entry, base), root_absolute(src, base));
		at = close;
	}
	return island_graph_script(graph, locations);
}
