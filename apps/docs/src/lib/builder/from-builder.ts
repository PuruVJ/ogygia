/**
 * Builder.io adapter (app-level prototype — not in the library yet).
 *
 * Builder is headless: its published content is JSON in Builder's own element shape. `builderSource`
 * maps that shape to ogygia's block tree and renders it through `blocks()` — so a Builder page becomes
 * an ordinary content entry `body`. In a real app the `from` glob would be a loader hitting Builder's
 * Content API; here we glob local fixtures in Builder's exact JSON shape.
 */
import { glob, blocks, mapRaw } from 'ogygia/content';
import type { BlockNode, BlockRegistry, GlobMap, Source } from 'ogygia/content';

/** A Builder element (the relevant subset): `component.name` + `component.options` + `children`. */
type BuilderElement = {
	component?: { name?: string; options?: Record<string, unknown> };
	children?: BuilderElement[];
};

/** Builder's `data.blocks` array → ogygia block tree. `component.name`→type, `options`→props. */
export function fromBuilder(elements: BuilderElement[] = []): BlockNode[] {
	return elements
		.filter((el) => el?.component?.name)
		.map((el) => ({
			type: el.component!.name as string,
			props: el.component!.options ?? {},
			...(el.children && el.children.length ? { children: fromBuilder(el.children) } : {})
		}));
}

/** Pull `data.blocks` out of a Builder content result (`{ data: { blocks } }` or a bare `{ blocks }`). */
function builderBlocks(resolved: unknown): BuilderElement[] {
	const r =
		resolved && typeof resolved === 'object' && 'default' in resolved
			? (resolved as { default: unknown }).default
			: resolved;
	const o = (r ?? {}) as { data?: { blocks?: BuilderElement[] }; blocks?: BuilderElement[] };
	return o.data?.blocks ?? o.blocks ?? [];
}

/**
 * A Builder.io loader, composed entirely from exported primitives: `glob` reads the JSON, `mapRaw`
 * converts each Builder result to `{ blocks: BlockNode[] }`, and `blocks()` renders the tree. Swap
 * `glob(input)` for any raw source (e.g. one that fetches Builder's Content API) and nothing else
 * changes.
 */
export function builderSource(input: GlobMap, registry: BlockRegistry): Source {
	const rawTrees = mapRaw(glob(input), (mod) => ({ blocks: fromBuilder(builderBlocks(mod)) }));
	return blocks(rawTrees, registry);
}
