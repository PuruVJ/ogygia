<script lang="ts">
	// `preset: 'chart'` resolves to { wake: 'visible', margin: '200px' } (see vite.config.ts)
	import BarChart from '$lib/BarChart.svelte' with { preset: 'chart' };
	let { data } = $props();
</script>

<h1 data-static-shell>Analytics</h1>
<p data-static-shell>
	Revenue: {data.stats.revenue} · orders: {data.stats.count} · generated {data.stats.generatedAt.toISOString()}
</p>

<div class="spacer">scroll down to hydrate the chart island (visible strategy)…</div>

<BarChart counts={data.stats.byStatus} />
