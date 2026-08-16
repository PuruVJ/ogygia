<script lang="ts">
	// The island block — its existence on a page is a ROW in the CMS body tree.
	let { start = 0 }: { start?: number } = $props();
	let count = $state(start);
</script>

<div class="blk-counter">
	<button onclick={() => (count -= 1)}>−</button>
	<output>{count}</output>
	<button onclick={() => (count += 1)}>+</button>
	<span>hydrated from a CMS block</span>
</div>

<style>
	.blk-counter {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0 0 1rem;
		padding: 0.75rem 1rem;
		border: 1px solid var(--og-line, #2a2d34);
		border-radius: 8px;
		width: fit-content;
	}
	button {
		width: 2rem;
		height: 2rem;
		border: 1px solid var(--og-line, #2a2d34);
		border-radius: 6px;
		background: transparent;
		color: inherit;
		font-size: 1.1rem;
		cursor: pointer;
	}
	button:hover {
		background: color-mix(in oklab, var(--og-accent, #6b8afd) 12%, transparent);
	}
	output {
		min-width: 2ch;
		text-align: center;
		font-variant-numeric: tabular-nums;
		font-weight: 700;
	}
	span {
		font-size: 0.8rem;
		color: var(--og-text-dim, #8a8f98);
	}
</style>
