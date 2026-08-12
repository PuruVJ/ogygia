<script lang="ts">
	// The blocks shape, obeying the wire law: a recursive tree whose leaves are ALREADY regions
	// (type→region resolved server-side; no registry, no functions cross). Awaited, the whole tree
	// renders same-pass into one HTML payload with nested self-describing islands + their CSS.
	import { Region, type RegionValue } from 'ogygia';
	import Self from './TreeHost.svelte';

	type Node = { of: RegionValue; children?: Node[] };
	let { nodes }: { nodes: Node[] } = $props();
</script>

<div class="shp-tree">
	{#each nodes as node, i (i)}
		<Region of={node.of}>
			{#if node.children?.length}<Self nodes={node.children} />{/if}
		</Region>
	{/each}
</div>

<style>
	.shp-tree {
		border: 2px inset #5a7a2a;
		padding: 0.6rem;
		display: grid;
		gap: 0.5rem;
	}
</style>
