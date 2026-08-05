<div class="widget">
	<span class="widget-label">Static snapshot</span>
	<div class="widget-row">
		<span class="widget-value">{start}</span>
		<button type="button" disabled>Increment</button>
	</div>
	{#if note}
		<p class="widget-meta">{note}</p>
	{/if}
</div>

<script lang="ts">
	let {
		start = 0,
		note = ''
	}: { start?: number; note?: string } = $props();
</script>
