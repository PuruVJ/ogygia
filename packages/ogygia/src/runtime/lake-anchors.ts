/**
 * After lifting lake content into a region, move trailing empty SSR comments
 * (`<!---->`) back into the region. Those are Boundary/host delimiters — not lake
 * content — and hydrate needs them for Boundary+Placeholder.
 */

const COMMENT_NODE = 8;

export interface NodeLike {
	nodeType: number;
	data?: string;
}

export interface ParentLike {
	appendChild(node: NodeLike): unknown;
}

export interface FragmentLike {
	lastChild: NodeLike | null;
	removeChild(node: NodeLike): unknown;
}

/** Relocate trailing empty comments from `frag` into `lake`. Returns how many moved. */
export function relocate_trailing_empty_comments(frag: FragmentLike, lake: ParentLike): number {
	const moved: NodeLike[] = [];
	while (frag.lastChild && frag.lastChild.nodeType === COMMENT_NODE && frag.lastChild.data === '') {
		const node = frag.lastChild;
		frag.removeChild(node);
		moved.unshift(node);
	}
	for (const n of moved) lake.appendChild(n);
	return moved.length;
}
