<script lang="ts">
	// Regression page: a deferred hole (in `lib/holes/`) whose body imports a nested wake island via
	// `'../NestedInner.svelte'`. The build must resolve that against the hole's real directory.
	import NestedHole from '$lib/holes/NestedHole.svelte' with { render: 'deferred' };
</script>

<h1>nested hole</h1>
<NestedHole who="deferred">
	{#snippet ogygiaFallback()}<p data-nested-hole-fallback>loading…</p>{/snippet}
</NestedHole>
