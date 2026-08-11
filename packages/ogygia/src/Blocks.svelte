<script>
	/**
	 * Recursive block-tree renderer — the render half of a Builder.io-style page.
	 *
	 * A page is data: a tree of nodes, each naming a block `type` plus `props` (and optional
	 * `children`, plus an optional `wake` schedule). The `registry` maps a type name to a component
	 * imported `with { region: 'raw' }` — a held region. Rendering a node is just
	 * `region(binding, node.props, { wake: node.wake })` through `<Region>`, which means:
	 *  - it SSRs inline in this pass (first paint, no client round-trip), and
	 *  - on the client only the block *types this tree actually names* pull their hydrate chunk, and
	 *    only when its registry import bakes a `wake` schedule (a plain import → HTML only, zero runtime JS).
	 * A registry of a thousand blocks, a page that names three → three chunks load. The other 997
	 * never ship. That selection is the framework's job; which component a type means is the user's
	 * (the explicit `registry` map — no guessing, no auto-discovery), and whether a block is interactive is its import mark (`wake:`) or a `schedule` resolver.
	 *
	 * Renders in the server pass, like every inline/SDUI region. An unregistered `type` is skipped
	 * (with a dev warning) rather than guessed at.
	 */
	import Region from './Region.svelte';
	import Self from './Blocks.svelte';
	import { region } from './region.js';

	/**
	 * @type {{
	 *   tree: import('./content/blocks.js').BlockNode | import('./content/blocks.js').BlockNode[] | null | undefined,
	 *   registry: Record<string, unknown>,
	 *   schedule?: (data: Record<string, unknown>) => { wake?: string, margin?: string }
	 * }}
	 */
	// `schedule` (optional): a `(data) => options` resolver forwarded as `region()`'s 3rd arg — for a
	// registry of `region: 'raw'` blocks that decides each one's timing from its data. When omitted,
	// each block's own baked `wake:` mark (or plain-import = static) decides.
	let { tree, registry, schedule } = $props();

	const nodes = $derived(Array.isArray(tree) ? tree : tree ? [tree] : []);

	/** @param {string} type */
	function binding_for(type) {
		const b = registry?.[type];
		if (!b && import.meta.env && import.meta.env.DEV) {
			console.warn(
				`[ogygia] blocks: no block registered for type ${JSON.stringify(type)} — skipped. ` +
					`Add it to your blocks({ … }) registry, or fix the type name.`
			);
		}
		return b;
	}
</script>

{#each nodes as node, i (node?.id ?? i)}
	{@const binding = binding_for(node?.type)}
	{#if binding}
		<Region of={region(/** @type {import('svelte').Component<Record<string, unknown>>} */ (binding), node.props ?? {}, schedule)}>
			{#if node.children && node.children.length}<Self tree={node.children} {registry} {schedule} />{/if}
		</Region>
	{/if}
{/each}
