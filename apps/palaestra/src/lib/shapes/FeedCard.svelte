<script lang="ts">
	// Instance 3: a region AS A PROP. The card decides where its media renders — composition
	// crosses as data, the leaf component places it. Ridge border fingerprint.
	import { Region, type RegionValue } from 'ogygia';
	let { author, media }: { author: string; media: RegionValue } = $props();
</script>

<article class="shp-card">
	<strong>{author}</strong>
	<Region of={media} />
</article>

<style>
	.shp-card {
		border: 4px ridge #7a2a5a;
		padding: 0.8rem;
		display: grid;
		gap: 0.5rem;
	}
</style>
