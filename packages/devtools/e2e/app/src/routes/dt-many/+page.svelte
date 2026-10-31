<script lang="ts">
	// SCALE for the devtools: 400 regions on one page (real pages in the field carry ~340). 40 wake at
	// load, 200 when visible (most below the first screen), 80 when idle, 80 lakes. Every tab must stay
	// responsive, the dock must open quickly, and its own work must stay small.
	import ManyItem from '$lib/dtmany/ManyItem.svelte' with { wake: 'load' };
	import ManyVisible from '$lib/dtmany/ManyItem.svelte' with { wake: 'visible' };
	import ManyIdle from '$lib/dtmany/ManyItem.svelte' with { wake: 'idle' };
	import ManyCard from '$lib/dtmany/ManyCard.svelte' with { wake: 'none' };
	const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
</script>

<h1>many islands</h1>
<div class="grid">
	{#each range(0, 40) as n (n)}<ManyItem {n} />{/each}
	{#each range(40, 120) as n (n)}<ManyIdle {n} />{/each}
	{#each range(120, 200) as n (n)}<ManyCard {n} />{/each}
	{#each range(200, 400) as n (n)}<ManyVisible {n} />{/each}
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 6px;
	}
</style>
