<script lang="ts">
	// Static leaf — HTML only. Dotted border = its CSS fingerprint for the harness.
	let { text }: { text: string } = $props();
</script>

<div class="shp-note">{text}</div>

<style>
	.shp-note {
		border: 2px dotted #7a5a2a;
		border-radius: 6px;
		padding: 0.5rem 0.8rem;
	}
</style>
