<script lang="ts">
	// The no-collection recipe — a component you own. `resolveBlocks` turns your tree + registry into
	// region nodes (server-side, where the signing key lives); this just renders them through <Region>
	// and recurses into children. Copy it, rename it, tweak the markup — it's yours.
	import { Region } from 'ogygia';
	import { blocks, type ResolvedBlockNode } from 'ogygia/content';
	import Self from './MyBlocks.svelte';

	let {
		tree,
		registry,
		nodes
	}: {
		tree?: unknown;
		registry?: Record<string, unknown>;
		nodes?: ResolvedBlockNode[];
	} = $props();

	// `tree` + `registry` at the top; recursion passes already-resolved `nodes` straight back in.
	const resolved = $derived(nodes ?? blocks.resolve(tree as never, registry ?? {}));
</script>

{#each resolved as node, i (i)}
	<Region of={node.of}>{#if node.children && node.children.length}<Self nodes={node.children} />{/if}</Region>
{/each}
