<script lang="ts">
	import '$lib/styles/widget.css';
	// Hydrated island that owns its lakes (portable bindings: host children cannot cross the
	// island boundary — lakes are imported here, not passed from the page).
	import FrozenCache from '$lib/playground/FrozenReport.svelte' with { hydrate: 'none' };
	import FrozenSwr from '$lib/playground/FrozenReport.svelte' with { preset: 'frozenSwr' };

	let { variant }: { variant: 'cache' | 'swr' } = $props();
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
		{#if variant === 'swr'}
			<FrozenSwr />
		{:else}
			<FrozenCache />
		{/if}
	{/if}
</div>
