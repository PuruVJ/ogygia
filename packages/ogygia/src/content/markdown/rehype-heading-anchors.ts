/**
 * Add a hover permalink anchor to every heading that has an id — a real `<a href="#id">` so clicking
 * it sets the hash URL and scrolls, with NO JavaScript (static markup, nav-safe by construction; the
 * SPA router treats a hash-only link as a native scroll). The icon is drawn by CSS on
 * `.ph-heading-anchor`; the accessible name rides an `aria-label` built from the heading text.
 *
 * Runs at the rehype (hast) stage, after the id is attached (`remark-heading-id` / `remark-headings`),
 * so the heading element already carries `properties.id`.
 */

type HastNode = {
	type?: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

const HEADINGS = new Set(['h2', 'h3', 'h4', 'h5', 'h6']);

const text_of = (node: HastNode): string => {
	if (node.type === 'text') return node.value ?? '';
	if (node.children) return node.children.map(text_of).join('');
	return '';
};

export function rehypeHeadingAnchors() {
	return (tree: HastNode) => {
		const visit = (node: HastNode) => {
			if (!node.children) return;
			for (const child of node.children) {
				if (
					child.tagName &&
					HEADINGS.has(child.tagName) &&
					typeof child.properties?.id === 'string'
				) {
					const id = child.properties.id as string;
					const label = text_of(child).trim();
					// mark the heading so CSS can anchor the absolutely-positioned link
					const cls = child.properties.className;
					child.properties.className = Array.isArray(cls)
						? [...cls, 'ph-heading']
						: cls
							? [String(cls), 'ph-heading']
							: ['ph-heading'];
					child.children = child.children ?? [];
					child.children.push({
						type: 'element',
						tagName: 'a',
						properties: {
							className: ['ph-heading-anchor'],
							href: `#${id}`,
							'aria-label': label ? `Permalink to “${label}”` : 'Permalink to this section'
						},
						children: []
					});
				}
				visit(child);
			}
		};
		visit(tree);
	};
}
