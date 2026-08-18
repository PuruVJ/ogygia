<script lang="ts">
	// A plain component that uses <Region> DIRECTLY (the held API), wrapping an INTERACTIVE dual
	// region — so on every page it emits an <ogygia-region wake="load"> and wants the runtime.
	//
	// The test: this same component is used two ways —
	//   • as an ISLAND on a csr=false page (`with { wake }`) — ogygia hydrates it, nested Region
	//     rides the parent island;
	//   • as a PLAIN component on a csr=true page — Kit hydrates the tree, the inner <ogygia-region>
	//     detects Kit already hydrated and steps aside (no double hydration, no crash).
	import { Region, region } from 'ogygia';
	import InnerWidget from './InnerWidget.svelte' with { wake: 'load' };

	let { start = 0 }: { start?: number } = $props();
	// A marked binding + region() → an interactive DUAL held region.
	const held = region(InnerWidget, { start, label: 'held' });
</script>

<div data-region-inside>
	<span>RegionInside wrapper</span>
	<Region of={held} />
</div>
