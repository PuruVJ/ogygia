<script lang="ts">
	// SCALE, silent: 5 lakes each awaiting the query, 60 islands that call nothing → no seed at all,
	// 60 hydrations.
	import LakeGreeting from '$lib/lakes/LakeGreeting.svelte' with { wake: 'none' };
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	const silent = Array.from({ length: 60 }, (_, i) => `s${i}`);
</script>

<h1>many, silent</h1>
{#each [1, 2, 3, 4, 5] as _}
	<LakeGreeting />
{/each}
{#each silent as label}
	<Counter {label} />
{/each}
