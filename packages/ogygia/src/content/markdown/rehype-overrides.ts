/**
 * Rewrite chosen markdown elements to the ogygia slot so app-land can override how they render.
 * `<a href="y">x</a>` → `<Og__Slot tag="a" href="y">x</Og__Slot>`. The compiler only ever knows tag
 * NAMES; the component VALUES live in `site({ components })` and reach the slot via context. The
 * slot falls back to the plain element for any tag nobody overrides, so wrapping is always safe.
 *
 * Capitalized tag name is deliberate — Svelte renders `<Og__Slot>` as a component (the injected
 * import), not an element. The injection happens in the preprocessor `markup` hook.
 */
export const SLOT_TAG = 'Og__Slot';

/** The curated default set: links, images, code. Widen via `markdown: { overrides: { tags } }`. */
export const DEFAULT_OVERRIDE_TAGS = ['a', 'img', 'code'] as const;

type HastNode = {
	type?: string;
	tagName?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

export function rehypeOverrides(tags: readonly string[]) {
	const set = new Set(tags);
	const walk = (node: HastNode) => {
		if (node.type === 'element' && node.tagName && set.has(node.tagName)) {
			node.properties = { ...(node.properties ?? {}), tag: node.tagName };
			node.tagName = SLOT_TAG;
		}
		if (Array.isArray(node.children)) node.children.forEach(walk);
	};
	return (tree: HastNode) => walk(tree);
}
