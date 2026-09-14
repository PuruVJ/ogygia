<script lang="ts">
	// SCALE: 5 lakes each awaiting the query, 20 silent islands, 20 reader islands (each its own SSR
	// call). The seed carries every greeting call (5 lake + 20 island), the 40 islands all hydrate
	// and none fetches.
	import LakeGreeting from '$lib/lakes/LakeGreeting.svelte' with { wake: 'none' };
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	import ResolvedGreeting from '$lib/ResolvedGreeting.svelte' with { wake: 'load' };
	const readers = Array.from({ length: 20 }, (_, i) => `r${i}`);
	const silent = Array.from({ length: 20 }, (_, i) => `s${i}`);
</script>

<h1>many</h1>
{#each [1, 2, 3, 4, 5] as _}
	<LakeGreeting />
{/each}
{#each silent as label}
	<Counter {label} />
{/each}
{#each readers as name}
	<ResolvedGreeting {name} />
{/each}
