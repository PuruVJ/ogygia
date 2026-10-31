<script lang="ts">
	// Interactive block — its registry import bakes `wake: 'load'`, so pages naming it
	// pull exactly one hydrate chunk. The button proves hydration.
	let { start = 0 }: { start?: number } = $props();
	let count = $state(start);
</script>

<div class="blk-cta">
	<button onclick={() => count++}>clicked {count}</button>
</div>

<style>
	.blk-cta {
		border: 3px solid #2a7a4a;
		border-radius: 10px;
		padding: 1rem;
		text-align: center;
	}
	.blk-cta button {
		font: inherit;
		padding: 0.4rem 1rem;
		cursor: pointer;
	}
</style>
