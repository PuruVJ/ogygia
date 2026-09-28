<script lang="ts">
	// DECOY: wake='interaction' — its first click IS its wake (and is replayed), so an early click here
	// is by design. Renders the same on both sides. No finding may name it.
	let count = $state(0);
</script>

<div data-dt="on-click">
	<button onclick={() => (count += 1)}>on click {count}</button>
</div>
