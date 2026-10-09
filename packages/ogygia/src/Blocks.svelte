<script lang="ts">
	/**
	 * Render a Builder.io-style page tree — the one block renderer, public and internal both.
	 *
	 * Two ways in, same output:
	 * - `<Blocks {tree} {registry} />` — you have a tree in hand (a prop, a literal, a one-off API
	 *   response), no content collection. Resolves `type → region` against your registry per render.
	 * - a `blocks()` collection body — already resolved at mint (registry consumed there), handed in as
	 *   `nodes`. Nothing re-resolves; the registry never rode along.
	 *
	 * Either way every block becomes a region and renders through `<Region>` — a block tree is just a
	 * shape of regions. Recursion passes the resolved `children` straight back in as `nodes`. An
	 * unregistered `type` is skipped with a dev warning (in `resolve_block_tree`).
	 *
	 * Server-pass component: the registry's `with { region: 'raw' }` bindings resolve on the server
	 * (where their signer lives), so `<Blocks>` renders in the SSR pass like every content body.
	 */
	import Region from './Region.svelte';
	import Self from './Blocks.svelte';
	import { resolve_block_tree } from './content/blocks.js';
	import type { BlockNode, BlockRegistry, BlockSchedule, ResolvedBlockNode } from './content/blocks.js';

	// `tree` + `registry` is the public API. `nodes` is the resolved channel — how a `blocks()` body
	// and recursion feed already-resolved regions back in; you rarely pass it yourself.
	let {
		tree,
		registry,
		schedule,
		nodes: resolved
	}: {
		tree?: BlockNode | BlockNode[] | null;
		registry?: BlockRegistry;
		schedule?: BlockSchedule;
		nodes?: ResolvedBlockNode[];
	} = $props();

	const nodes = $derived(resolved ?? resolve_block_tree(tree, registry ?? {}, schedule));
</script>

{#each nodes as node, i (i)}
	<Region of={node.of}>{#if node.children && node.children.length}<Self nodes={node.children} />{/if}</Region>
{/each}
