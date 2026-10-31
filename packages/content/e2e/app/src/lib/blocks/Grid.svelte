<script lang="ts">
	import type { Snippet } from 'svelte';
	// Container block — nested nodes render through `children` (Blocks recurses into the slot).
	let { children }: { children?: Snippet } = $props();
</script>

<div class="blk-grid">{@render children?.()}</div>

<style>
	.blk-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
		margin-block: 1rem;
	}
</style>
