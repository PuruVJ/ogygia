<script lang="ts">
	// query.batch demo: three simultaneous getSquare() calls in the same tick collapse into ONE
	// network request. All three results share the same `batchAt` (one server run) and report the
	// batch size (3). Proves Kit's reused client-side batching works inside an island.
	import { getSquare } from '$lib/greetings.remote';

	const a = getSquare(2);
	const b = getSquare(5);
	const c = getSquare(9);
</script>

<div class="island" data-batch-probe>
	<svelte:boundary>
		{#await Promise.all([a, b, c]) then [r2, r5, r9]}
			<ul>
				<li data-batch-2>2² = {r2.square} (batchAt {r2.batchAt}, size {r2.size})</li>
				<li data-batch-5>5² = {r5.square} (batchAt {r5.batchAt}, size {r5.size})</li>
				<li data-batch-9>9² = {r9.square} (batchAt {r9.batchAt}, size {r9.size})</li>
			</ul>
			<p data-batch-onerun>{r2.batchAt === r5.batchAt && r5.batchAt === r9.batchAt ? 'one batched run' : 'multiple runs'}</p>
		{/await}
		{#snippet pending()}<span data-batch-pending>batching…</span>{/snippet}
	</svelte:boundary>
</div>
