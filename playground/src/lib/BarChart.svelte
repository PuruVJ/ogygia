<script lang="ts">
	// Chart island (no chart lib — plain SVG). Hydrates on `visible`. Prop is a Map.
	let { counts } = $props();
	const entries = $derived([...counts.entries()]);
	const max = $derived(Math.max(...entries.map(([, v]) => v), 1));
</script>

<div class="island" data-barchart>
	<strong>orders by status</strong>
	<svg width="360" height="170" role="img" aria-label="orders by status">
		{#each entries as [label, v], i}
			<rect x={i * 70 + 10} y={150 - (v / max) * 130} width="50" height={(v / max) * 130} fill="#4f46e5"
			></rect>
			<text x={i * 70 + 35} y="150" dy="12" font-size="9" text-anchor="middle">{label}</text>
			<text x={i * 70 + 35} y={150 - (v / max) * 130 - 4} font-size="9" text-anchor="middle">{v}</text>
		{/each}
	</svg>
</div>
