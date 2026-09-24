/**
 * PRELOAD AN ISLAND'S GRAPH AT WAKE — the runtime half of the island graph (../island-graph.ts).
 *
 * The page carries, as data, the chunks each island entry needs. When an island starts to load (its
 * wake, after the wake gate; a hover or router warm), `preload_island_graph(entry)` inserts one
 * `<link rel="modulepreload">` per chunk not yet linked, in the same task as the entry's `import()`.
 * The browser then fetches the entry and its whole graph at once — no waterfall of discovering each
 * import after the last one parsed — and only for islands that actually start.
 *
 * The graph is read lazily from every `script[data-ogygia-graph]` in the document (the document
 * tail, a head copy a self-contained render emitted, the body a router swap brought in), each script
 * once. Entries and chunks are content-hashed URLs, so a list read on one page is never wrong on the
 * next: nothing to invalidate. A router warm reads the NEXT page's graph out of its fetched HTML
 * (`register_island_graph`) before that page is in the DOM.
 */
import { ISLAND_GRAPH_ATTR, decode_island_graph } from '../island-graph.js';

const GRAPH_SELECTOR = `script[${ISLAND_GRAPH_ATTR}]`;
const MODULEPRELOAD_SELECTOR = 'link[rel="modulepreload"]';
/** Marks a link this module inserted (tests and devtools tell them from the HTML's own). */
export const GRAPH_PRELOAD_ATTR = 'data-ogygia-graph-preload';

/** entry URL (absolute) → its chunk URLs (absolute). */
const graph = new Map<string, string[]>();
let read_scripts = new WeakSet<Element>();
/** Chunk URLs (absolute) already linked — ours, or a modulepreload the HTML carried. */
let linked: Set<string> | null = null;

function absolute(href: string, base: string): string | null {
	try {
		return new URL(href, base).href;
	} catch {
		return null;
	}
}

/** Merge one graph script's text; hrefs resolve against `base` (the document the text came from). */
export function register_island_graph(text: string, base: string = location.href): void {
	for (const [entry, hrefs] of decode_island_graph(text)) {
		const key = absolute(entry, base);
		if (!key || graph.has(key)) continue;
		const list: string[] = [];
		for (const href of hrefs) {
			const url = absolute(href, base);
			if (url) list.push(url);
		}
		graph.set(key, list);
	}
}

function read_document_graphs(): void {
	for (const s of document.querySelectorAll(GRAPH_SELECTOR)) {
		if (read_scripts.has(s)) continue;
		read_scripts.add(s);
		register_island_graph(s.textContent ?? '');
	}
}

function linked_set(): Set<string> {
	if (linked) return linked;
	linked = new Set();
	for (const l of document.querySelectorAll(MODULEPRELOAD_SELECTOR)) {
		const url = absolute(l.getAttribute('href') ?? '', location.href);
		if (url) linked.add(url);
	}
	return linked;
}

/**
 * Start fetching every chunk `entry`'s code needs: one modulepreload link per chunk not linked yet.
 * Call it in the same task as the entry's `import()`. An entry the page has no graph for (dev, an
 * island inside a fetched hole answer) preloads nothing — its `import()` still finds its chunks.
 */
export function preload_island_graph(entry: string, base: string = location.href): void {
	if (typeof document === 'undefined') return;
	const key = absolute(entry, base);
	if (!key) return;
	if (!graph.has(key)) read_document_graphs();
	const hrefs = graph.get(key);
	if (!hrefs || hrefs.length === 0) return;
	const seen = linked_set();
	for (const href of hrefs) {
		if (seen.has(href)) continue;
		seen.add(href);
		const link = document.createElement('link');
		link.rel = 'modulepreload';
		link.href = href;
		link.setAttribute(GRAPH_PRELOAD_ATTR, '');
		document.head.appendChild(link);
	}
}

/** Test seam: forget every graph read and every chunk linked. */
export function reset_island_graph(): void {
	graph.clear();
	read_scripts = new WeakSet();
	linked = null;
}
