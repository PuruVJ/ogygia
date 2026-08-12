<script lang="ts">
	/**
	 * Live demo of the `blocks` renderer. The registry (a `.ts` module) is plain imports for the static
	 * blocks — they render inline, zero JS — and one `with { wake: 'load' }` block that bakes its
	 * schedule, so it is the only chunk this page fetches. The `tree` is plain data — swap it for JSON
	 * from a CMS and nothing else changes.
	 */
	import BlockTree from './blocks/BlockTree.svelte';
	import type { BlockNode } from 'ogygia/content';
	import { registry } from './blocks/registry';

	const tree: BlockNode[] = [
		{
			type: 'Hero',
			props: { title: 'This panel is a block tree', tagline: 'Rendered from JSON through the registry.' }
		},
		{
			type: 'Grid',
			children: [
				{ type: 'Feature', props: { title: 'Static blocks', body: 'Hero, Grid and Feature are plain imports — zero JS.' } },
				{ type: 'Feature', props: { title: 'Only what is named', body: 'A registry of thousands; this page names four.' } }
			]
		},
		{ type: 'CounterBlock', props: { label: 'Interactive block (wake: load)', start: 3 } }
	];
</script>

<div class="blocks-demo">
	<BlockTree {tree} {registry} />
</div>

<style>
	.blocks-demo {
		display: grid;
		gap: 0.6rem;
	}
</style>
