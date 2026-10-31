<script lang="ts">
	// PLANTED: a third-party script edits this island's markup before it wakes (dt-third).
	let count = $state(0);
</script>

<div data-dt="third-target">
	<button onclick={() => (count += 1)}>third target {count}</button>
</div>
