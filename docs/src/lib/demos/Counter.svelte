<div class="widget" data-counter>
	<span class="widget-label">{label}</span>
	<div class="widget-row">
		<span class="widget-value">{count}</span>
		<button type="button" onclick={() => (count += 1)}>Increment</button>
	</div>
	{#if note}
		<p class="widget-meta">{note}</p>
	{/if}
</div>

<script lang="ts">
	let {
		start = 0,
		label = 'Counter',
		note = ''
	}: { start?: number; label?: string; note?: string } = $props();

	// svelte-ignore state_referenced_locally
	let count = $state(start);
</script>
