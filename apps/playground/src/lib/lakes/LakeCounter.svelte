<script lang="ts">
	// Hydrated island that contains lakes in its own tree (portable bindings: host children
	// cannot cross the island boundary — lakes are imported here, not passed from the page).
	import FrozenBox from './FrozenBox.svelte' with { wake: 'none' };
	import FrozenSwr from './FrozenBox.svelte' with { preset: 'frozenSwr' };

	let { swr = false }: { swr?: boolean } = $props();
	let count = $state(0);
	let show = $state(true);
</script>

<div class="island" data-lake-counter>
	<button data-count-btn onclick={() => (count += 1)}>island count: {count}</button>
	<button data-toggle-btn onclick={() => (show = !show)}>toggle lake</button>
	{#if show}
		{#if swr}
			<FrozenSwr />
		{:else}
			<FrozenBox />
		{/if}
	{/if}
</div>
