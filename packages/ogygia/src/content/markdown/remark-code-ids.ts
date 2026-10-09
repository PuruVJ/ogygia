/**
 * Give every fenced code block a STABLE, content-addressed id so it can be permalinked:
 * `slug-code-<hash>`, where `slug` is the nearest preceding scoped heading id and `<hash>` is a short
 * hash of the code text. Blocks before any heading get a bare `code-<hash>`.
 *
 * Why content-hash instead of a running index (`slug-code-2`): the id survives reordering and
 * inserting blocks earlier in the section — only editing the code itself retires its link (which is
 * correct). Because it's assigned at BUILD time, the id ships in the SSR HTML, so a cold-loaded
 * permalink scrolls to the block with no JavaScript. (CodeChrome's copy/permalink buttons then just
 * read `pre.id`; it keeps a matching client-side fallback for blocks a live region inserts later.)
 *
 * Mechanism — why remark, not rehype: Shiki's highlighter returns an opaque HTML STRING per fence, so
 * by the rehype (hast) stage there is no traversable `<pre>` node to tag. Here at the mdast stage the
 * `code` nodes are still real nodes and document order + heading context exist. We stash the computed
 * id onto `code.meta` (mdsvex threads `meta` into the highlighter as its third argument), and
 * `create_mdsvex_highlighter` parses it back out and writes `id="…"` onto the emitted `<pre>`.
 *
 * Runs **after** {@link remarkHeadings} (headings already carry the scoped `hProperties.id`) and
 * **before** mdsvex's own `highlight_blocks` (which is appended after all remark plugins), so the id
 * is on `code.meta` by the time the highlighter sees the node.
 */

// ── regexes
const WS_G = /\s+/g;

type MdNode = {
	type?: string;
	depth?: number;
	value?: string;
	meta?: string | null;
	children?: MdNode[];
	data?: { hProperties?: Record<string, string> } & Record<string, unknown>;
};

/** The token our highlighter looks for on `code.meta`. Kept distinct so it can't collide with a real
 *  fence info flag; the highlighter strips it before doing anything else with meta. */
export const CODE_ID_META = 'ogygia-code-id';

/** FNV-1a → base36. Tiny, stable, no crypto — collisions are disambiguated by the caller anyway. */
export function hash_code(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

export function remarkCodeIds() {
	return (tree: MdNode) => {
		let heading: string | null = null;
		const seen = new Set<string>();

		const walk = (node: MdNode) => {
			if (node.type === 'heading' && typeof node.data?.hProperties?.id === 'string') {
				heading = node.data.hProperties.id;
				return; // headings hold no code
			}
			if (node.type === 'code') {
				assign(node, heading, seen);
				return; // a code node has no children to track
			}
			if (Array.isArray(node.children)) node.children.forEach(walk);
		};
		walk(tree);
	};
}

/** Compute `slug-code-<hash>` (or `code-<hash>` outside any section) and stash it on `code.meta`. */
function assign(node: MdNode, heading: string | null, seen: Set<string>): void {
	// Normalize whitespace so trivial reformatting (indent tweaks, trailing spaces) keeps the same hash.
	const text = (node.value ?? '').replace(WS_G, ' ').trim();
	const h = hash_code(text);
	const base = heading ? `${heading}-code-${h}` : `code-${h}`;
	let id = base;
	let n = 2;
	while (seen.has(id)) id = `${base}-${n++}`; // identical blocks in one section still get unique ids
	seen.add(id);
	node.meta = `${node.meta ? node.meta + ' ' : ''}${CODE_ID_META}=${id}`;
}
