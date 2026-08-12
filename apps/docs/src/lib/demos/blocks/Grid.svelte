<script lang="ts">
	import type { Snippet } from 'svelte';
	// A container block: renders its child blocks in a grid. `children` is the nested block subtree,
	// rendered by the recomposer and handed to this block — this is how a block tree nests.
	let { children }: { children?: Snippet } = $props();
</script>

<div class="blk-grid">{@render children?.()}</div>

<style>
	.blk-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.6rem;
	}
	@media (max-width: 30rem) {
		.blk-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
