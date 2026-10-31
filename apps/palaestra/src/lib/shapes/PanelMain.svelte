<script lang="ts">
	// The awaited leaf in the object shape. Double border fingerprint.
	let { title }: { title: string } = $props();
</script>

<div class="shp-main"><h3>{title}</h3></div>

<style>
	.shp-main {
		border: 5px double #5a2a7a;
		padding: 0.8rem;
	}
	.shp-main h3 {
		margin: 0;
	}
</style>
