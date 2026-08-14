/**
 * Collect every markdown link into `metadata.links` — the raw material for pharos's link audit.
 * Mirrors {@link remarkHeadings}: the collected array is stashed on `file.data.fm.links`, mdsvex
 * emits it with the module `metadata`, and the `markdown` format lifts it onto the entry's `meta`.
 *
 * Collection is TOTAL (external, internal, anchors, mailto — everything); classification happens at
 * audit time, where the mount base is known. Best-effort by design: markdown `link` nodes only —
 * raw `<a>` HTML and component `href` props are invisible to the mdast pass.
 */
import type { LinkRef } from '../index.js';

type MdNode = {
	type?: string;
	url?: string;
	value?: string;
	children?: MdNode[];
	position?: { start?: { line?: number } };
};

export function remarkLinks() {
	return (tree: MdNode, file: { data: Record<string, unknown> }) => {
		const links: LinkRef[] = [];

		const text_of = (node: MdNode): string => {
			if (typeof node.value === 'string') return node.value;
			if (Array.isArray(node.children)) return node.children.map(text_of).join('');
			return '';
		};

		const walk = (node: MdNode) => {
			if (node.type === 'link' && typeof node.url === 'string') {
				const line = node.position?.start?.line;
				links.push({
					href: node.url,
					text: text_of(node).trim(),
					// Approximate: mdsvex parses frontmatter before remark sees the tree, so positions are
					// relative to the post-frontmatter text. Good enough to anchor an error.
					...(typeof line === 'number' ? { line } : {})
				});
			}
			if (Array.isArray(node.children)) node.children.forEach(walk);
		};

		walk(tree);

		const fm = (file.data.fm ??= {}) as Record<string, unknown>;
		fm.links = links;
	};
}
