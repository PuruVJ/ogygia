<script lang="ts">
	// DECOY: below the fold with wake='visible' — the right choice. No finding may name it.
	let count = $state(0);
</script>

<div data-dt="below-lazy">
	<button onclick={() => (count += 1)}>below, lazy {count}</button>
</div>
