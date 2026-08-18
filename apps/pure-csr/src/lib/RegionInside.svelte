<script lang="ts">
	// Uses <Region> DIRECTLY around an INTERACTIVE dual region — so it emits <ogygia-region wake>
	// and wants the runtime. In THIS app the runtime chunk is never emitted (pure csr=true), so the
	// test is: does the page still render + hydrate via Kit, or does it break?
	import { Region, region } from 'ogygia';
	import InnerWidget from './InnerWidget.svelte' with { wake: 'load' };

	let { start = 0 }: { start?: number } = $props();
	const held = region(InnerWidget, { start, label: 'held' });
</script>

<div data-region-inside>
	<span>RegionInside wrapper</span>
	<Region of={held} />
</div>
