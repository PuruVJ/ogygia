<script lang="ts">
	// A region delivered INSIDE another region's props. Dashed border fingerprint.
	let { src }: { src: string } = $props();
</script>

<div class="shp-video">▶ {src}</div>

<style>
	.shp-video {
		border: 3px dashed #2a7a5a;
		padding: 0.6rem;
	}
</style>
