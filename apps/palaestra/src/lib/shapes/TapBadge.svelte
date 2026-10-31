<script lang="ts">
	// Interactive leaf — its registry import bakes wake:'load'. Solid border fingerprint.
	let { start = 0 }: { start?: number } = $props();
	let n = $state(start);
</script>

<button class="shp-tap" onclick={() => n++}>taps {n}</button>

<style>
	.shp-tap {
		border: 4px solid #2a5a7a;
		border-radius: 8px;
		padding: 0.4rem 0.9rem;
		font: inherit;
		cursor: pointer;
	}
</style>
