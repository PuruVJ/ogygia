<script lang="ts">
	// Instance 4: the RECOMPOSER. An app-owned marked component that takes a data shape whose
	// leaves are regions and turns it back into markup. Groove border fingerprint.
	import { Region, type RegionValue } from 'ogygia';
	let { items }: { items: RegionValue[] } = $props();
</script>

<div class="shp-list">
	{#each items as it, i (i)}
		<Region of={it} />
	{/each}
</div>

<style>
	.shp-list {
		border: 3px groove #7a7a2a;
		padding: 0.7rem;
		display: grid;
		gap: 0.5rem;
	}
</style>
