<script lang="ts">
	// DECOY: a small island that renders the same on both sides and wakes quickly. No finding may name it.
	let count = $state(0);
</script>

<div data-dt="healthy">
	<button onclick={() => (count += 1)}>healthy {count}</button>
</div>
