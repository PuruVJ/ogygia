<script lang="ts">
	// A load island that takes everything as PROPS (never reads $page): the props-tail fixture.
	let { label = 'tally', start = 0 }: { label?: string; start?: number } = $props();
	// svelte-ignore state_referenced_locally
	let n = $state(start);
</script>

<div class="tally" data-tally={label}>
	<span data-tally-label>{label}</span>
	<button data-tally-btn onclick={() => (n += 1)}>n {n}</button>
</div>

<style>
	.tally {
		display: inline-flex;
		gap: 0.5rem;
		padding: 0.25rem 0.5rem;
		border: 1px solid #999;
	}
</style>
