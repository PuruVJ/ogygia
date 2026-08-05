<script lang="ts">
	// A hydrated island (hydrate: 'load') that contains a lake in its children. The counter proves
	// it is interactive. The {#if} toggle exercises remount (default cache).
	let { children } = $props();
	let count = $state(0);
	let show = $state(true);
</script>

<div class="widget" data-lake-shell style="max-width: 420px;">
	<span class="widget-label">interactive island (hydrated)</span>
	<div class="widget-row">
		<span class="widget-value" data-count>{count}</span>
		<div style="display: flex; gap: 0.5rem;">
			<button type="button" data-count-btn onclick={() => (count += 1)}>count +1</button>
			<button type="button" data-toggle-btn onclick={() => (show = !show)}>toggle lake</button>
		</div>
	</div>

	{#if show}
		{@render children?.()}
	{/if}
</div>
