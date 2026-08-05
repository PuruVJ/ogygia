<script lang="ts">
	// A hydrated island (hydrate: 'load') that CONTAINS a lake in its children. Interactive (the
	// counter proves it hydrated). The {#if} lets us toggle the lake to exercise remount policy

	// (re-creation): 'cache' re-inserts the frozen DOM, 'empty' leaves it blank.
	let { children } = $props();
	let count = $state(0);
	let show = $state(true);
</script>

<div class="island" data-lake-counter>
	<button data-count-btn onclick={() => (count += 1)}>island count: {count}</button>
	<button data-toggle-btn onclick={() => (show = !show)}>toggle lake</button>
	{#if show}
		{@render children?.()}
	{/if}
</div>
