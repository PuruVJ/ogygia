<script lang="ts">
	import HeavyRow from './HeavyRow.svelte';

	// Renders `rows` HeavyRow children. Its own self-time is small; its TOTAL time (in the
	// profiler) folds in every HeavyRow, so this shows how "total vs self" localizes cost.
	let { rows = 800, seed = 12345 }: { rows?: number; seed?: number } = $props();
	const list = Array.from({ length: rows }, (_, i) => i);
</script>

<table class="ht">
	<thead>
		<tr><th>#</th><th>sku</th><th>value</th><th>chg</th><th>updated</th><th>tags</th></tr>
	</thead>
	<tbody>
		{#each list as i (i)}
			<HeavyRow {i} {seed} />
		{/each}
	</tbody>
</table>

<style>
	.ht {
		border-collapse: collapse;
		width: 100%;
	}
	.ht th {
		text-align: left;
		padding: 4px 8px;
		font-size: 0.7rem;
		color: #718096;
		border-bottom: 2px solid #cbd5e0;
	}
</style>
