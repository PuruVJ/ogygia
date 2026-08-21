<script lang="ts">
	// The island sits in a STRUCTURALLY-STABLE slot (`.shell > .rail > .slot > .deeper`) that Page Y
	// mirrors exactly. Everything ELSE on the page differs. Same wrapper chain + same island props →
	// same reconcile key at a matched position → the reconciler keeps the live island across the nav.
	import DeepCounter from '$lib/lab/DeepCounter.svelte' with { wake: 'load', keep: 'deep' };
</script>

<h2 data-deep-page>Page X</h2>
<div class="shell">
	<div class="body">
		<p>Page-X only: some prose, a table, whatever. This column re-renders on nav.</p>
		<ul><li>x-item-1</li><li>x-item-2</li></ul>
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
