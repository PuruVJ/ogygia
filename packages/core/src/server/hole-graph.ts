/**
 * WHAT A HOLE'S HEAD CARRIES INTO ITS ANSWER. A hole renders on its own, and the endpoint ships only
 * the body — but the islands inside it write into the render's head what the page needs of them:
 *
 * - their GRAPH (the chunks their code needs — island-graph.ts). Without it the islands a hole brings
 *   loaded in a waterfall: each chunk discovered only after the last one parsed (+1.1 s at a 150 ms
 *   round trip, measured). Carried as one script; the runtime reads any graph script in the document
 *   (runtime/island-graph-preload.ts), so a nested island's wake preloads its whole graph at once.
 * - their CSS (the `data-ogygia-region-css` tags Region.svelte writes for each island it renders: the
 *   island's own chunk CSS, exact — the bundler's, over what the island really imports). Without it
 *   an island in a hole had only the hole's own sheet, and whatever it rendered after the server
 *   render (a dropdown's contents, a branch behind a click) arrived unstyled. Carried as written; the
 *   runtime hoists these tags from an answer into `<head>` before the swap, deduped by href.
 *
 * URLs are made root-absolute (the graph here, the CSS tags by the answer's own absolutizing pass):
 * the answer lands in a page at any depth, and a `./_app/…` resolved there would 404. indexOf only.
 */
import {
	ISLAND_GRAPH_ATTR,
	decode_island_graph,
	decode_island_locations
} from '../island-graph.ts';
import { island_graph_script } from './document-tail.ts';

function root_absolute(value: string, base: URL): string {
	if (!value.startsWith('./') && !value.startsWith('../')) return value;
	try {
		const u = new URL(value, base);
		return u.origin === base.origin ? u.pathname + u.search + u.hash : value;
	} catch {
		return value;
	}
}

/** What the answer carries of the render's head: its islands' graph and their CSS ('' for none). */
export function hole_head(head: string, base: URL | undefined): string {
	return (base ? hole_graph_script(head, base) : '') + head_region_css(head);
}

const REGION_CSS_ATTR = 'data-ogygia-region-css';

/** Every region-CSS tag in the head, as written (`<link … data-ogygia-region-css>` or
 *  `<style data-ogygia-region-css="…">…</style>`). */
export function head_region_css(head: string): string {
	let out = '';
	for (
		let at = head.indexOf(REGION_CSS_ATTR);
		at !== -1;
		at = head.indexOf(REGION_CSS_ATTR, at + 1)
	) {
		const start = head.lastIndexOf('<', at);
		if (start === -1) continue;
		const is_style = head.startsWith('<style', start);
		const end = is_style ? head.indexOf('</style>', at) : head.indexOf('>', at);
		if (end === -1) break;
		const stop = is_style ? end + '</style>'.length : end + 1;
		out += head.slice(start, stop);
		at = stop - 1;
	}
	return out;
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
			if (!graph.has(key))
				graph.set(
					key,
					hrefs.map((h) => root_absolute(h, base))
				);
		}
		for (const [entry, src] of decode_island_locations(text))
			locations.set(root_absolute(entry, base), root_absolute(src, base));
		at = close;
	}
	return island_graph_script(graph, locations);
}
