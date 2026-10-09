<script lang="ts">
	// PLANTED eager-offscreen: wake='load' but it sits far below the first screen.
	let count = $state(0);
</script>

<div data-dt="below-eager">
	<button onclick={() => (count += 1)}>below, eager {count}</button>
</div>
