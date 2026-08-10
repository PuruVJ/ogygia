/**
 * `blocks()` — a source builder for Builder.io-style pages: a JSON tree of block nodes rendered
 * through a registry. Each entry's `body` is the rendered tree, so you render it with
 * `<Region of={entry.body} />`, exactly like a markdown body.
 *
 *   import { content, blocks } from 'ogygia/content';
 *   import Hero    from '$lib/blocks/Hero.svelte'    with { region: 'raw' };
 *   import Pricing from '$lib/blocks/Pricing.svelte' with { region: 'raw' };
 *
 *   export const pages = content({ loader: blocks(import.meta.glob('./pages/*.json'), { Hero, Pricing }) });
 *
 * The registry values are `with { region: 'raw' }` imports (held regions): each block SSRs inline and,
 * on the client, only the block types a page names — and only nodes that set a `wake` schedule — pull
 * their hydrate chunk (a node with no `wake` is HTML only, zero runtime JS). The `Blocks` renderer is
 * dynamic-imported in `init()`, so this module (and `ogygia/content`) never pulls a `.svelte` file at
 * import time.
 */
import type { Component } from 'svelte';
import { region } from '../region.js';
import { defineSource, toRawSource, type Format, type GlobMap, type RawSource, type Source } from './source.js';

/** One node in a block tree: a `type` naming a registered block, its `props`, and nested `children`.
 * A block's wake schedule is baked into its registry import (`with { wake: 'load' }`) or decided by a
 * `schedule` resolver passed to `<Blocks>` — not carried on the node. */
export type BlockNode = {
	type: string;
	id?: string;
	props?: Record<string, unknown>;
	children?: BlockNode[];
};

/** A block source: an array of nodes, a single node, or `{ blocks, meta }` (frontmatter in `meta`). */
export type BlockSource =
	| BlockNode
	| BlockNode[]
	| { blocks: BlockNode[]; meta?: Record<string, unknown> };

/** Map from a block `type` name to the component it renders — a `with { region: 'raw' }` import. */
export type BlockRegistry = Record<string, unknown>;

/** If Vite wrapped a lone JSON `default` export, unwrap it. */
function unwrap_default(resolved: unknown): unknown {
	if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) return resolved;
	const mod = resolved as Record<string, unknown>;
	if (!('default' in mod)) return resolved;
	const keys = Object.keys(mod).filter((k) => k !== '__esModule');
	if (keys.length === 1 && keys[0] === 'default') return mod.default;
	return resolved;
}

/** Pull the block tree + frontmatter data out of the source's several accepted shapes. */
function normalize(value: unknown): { tree: BlockNode[]; data: Record<string, unknown> } {
	if (Array.isArray(value)) return { tree: value as BlockNode[], data: {} };
	if (value && typeof value === 'object') {
		const o = value as Record<string, unknown>;
		if (Array.isArray(o.blocks)) {
			return { tree: o.blocks as BlockNode[], data: ((o.meta ?? o.data ?? {}) as Record<string, unknown>) };
		}
		if (typeof o.type === 'string') return { tree: [o as unknown as BlockNode], data: {} };
	}
	return { tree: [], data: {} };
}

/**
 * Build a `blocks` source. Every entry's `body` is the recursive `Blocks` renderer invoked with that
 * page's tree + the registry. `data` carries any `meta` frontmatter the page declared.
 */
export function blocks(
	input: GlobMap | RawSource<unknown>,
	registry: BlockRegistry,
	opts: { id?: (key: string) => string } = {}
): Source {
	let Blocks: Component<Record<string, unknown>>;
	const format: Format<unknown> = (resolved) => {
		const { tree, data } = normalize(unwrap_default(resolved));
		return { data, body: region(Blocks, { tree, registry }) };
	};
	return defineSource(toRawSource(input, opts), format, {
		init: async () => {
			Blocks = (await import('../Blocks.svelte')).default as Component<Record<string, unknown>>;
		}
	});
}
