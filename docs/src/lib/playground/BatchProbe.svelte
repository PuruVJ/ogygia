<script lang="ts">
	// query.batch: three getSquare() calls fired in the same tick collapse into ONE request. All
	// three results share the same `batchAt` (one server run) and report the batch size (3).
	import { getSquare } from '$lib/playground/data.remote';

	const a = getSquare(2);
	const b = getSquare(5);
	const c = getSquare(9);
</script>

<div class="widget" data-batch-probe style="max-width: 320px;">
	<span class="widget-label">query.batch · 3 calls → 1 request</span>
	<svelte:boundary>
		{#await Promise.all([a, b, c]) then [r2, r5, r9]}
			<ul style="margin: 0; padding-left: 1.1rem;">
				<li data-batch-2>2² = {r2.square}</li>
				<li data-batch-5>5² = {r5.square}</li>
				<li data-batch-9>9² = {r9.square}</li>
			</ul>
			<p class="widget-meta" data-batch-onerun>
				{r2.batchAt === r5.batchAt && r5.batchAt === r9.batchAt
					? `one batched run · size ${r2.size} · batchAt ${r2.batchAt}`
					: 'multiple runs'}
			</p>
		{/await}
		{#snippet pending()}<p class="widget-meta" data-batch-pending>batching…</p>{/snippet}
	</svelte:boundary>
</div>
