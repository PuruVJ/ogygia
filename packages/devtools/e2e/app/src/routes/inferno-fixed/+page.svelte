<script lang="ts">
	// /inferno's page over the fixed load and card (see +page.server.ts).
	import ResultCard from '$lib/inferno-fixed/ResultCard.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>Inferno · {data.count} results for “{data.term}”</title>
</svelte:head>

<main class="inferno">
	<h1>{data.count} results for “{data.term}”</h1>
	<p class="hint">
		{data.indexed} indexed · total {data.total.toFixed(2)} · {data.pages.length} pages · services {data.services.join(', ')} ·
		{data.drained} jobs · manifest {data.manifest} chars · stock {data.stock.map((s) => s.stock).join(' ')}
	</p>
	<div class="grid">
		{#each data.results as p, i (p.id)}
			<ResultCard {p} rank={i} />
		{/each}
	</div>
	<details>
		<summary>Site map</summary>
		{@html data.sitemap}
	</details>
</main>

<style>
	.inferno {
		max-width: 1200px;
		margin: 0 auto;
		padding: 16px;
		font: 14px/1.4 system-ui, sans-serif;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 10px;
	}
	.hint {
		color: #666;
		font-size: 12px;
	}
</style>
