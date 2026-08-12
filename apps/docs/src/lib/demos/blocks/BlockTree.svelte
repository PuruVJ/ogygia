<script lang="ts">
	// The no-collection recipe (see the Blocks doc): `blocks.resolve` turns a tree + registry into
	// region nodes, this renders them through <Region> and recurses. Yours to own — no shipped component.
	import { Region } from 'ogygia';
	import { blocks, type ResolvedBlockNode } from 'ogygia/content';
	import Self from './BlockTree.svelte';

	let {
		tree,
		registry,
		nodes
	}: { tree?: unknown; registry?: Record<string, unknown>; nodes?: ResolvedBlockNode[] } = $props();

	const resolved = $derived(nodes ?? blocks.resolve(tree as never, registry ?? {}));
</script>

{#each resolved as node, i (i)}
	<Region of={node.of}>{#if node.children && node.children.length}<Self nodes={node.children} />{/if}</Region>
{/each}
