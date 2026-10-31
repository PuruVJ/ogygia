<script lang="ts">
	// Same stable slot as Page X, different everything-else. The deep island is kept across X ⇄ Y.
	import DeepCounter from '$lib/lab/DeepCounter.svelte' with { wake: 'load', keep: 'deep' };
</script>

<h2 data-deep-page>Page Y</h2>
<div class="shell">
	<div class="body">
		<p>Page-Y only: a completely different article. This column re-renders on nav.</p>
		<blockquote>y quote, not on x</blockquote>
	</div>
	<div class="rail">
		<div class="slot">
			<div class="deeper">
				<DeepCounter label="deep-shared" />
			</div>
		</div>
	</div>
</div>

<style>
	.shell { display: grid; grid-template-columns: 1fr 320px; gap: 20px; }
	.rail { border-left: 1px solid #e2e8f0; padding-left: 16px; }
	.deeper { padding: 8px; border-left: 3px solid #cbd5e1; }
</style>
