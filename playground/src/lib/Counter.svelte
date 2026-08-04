<script lang="ts">
	let { start = 0, label = 'Counter' } = $props();
	// svelte-ignore state_referenced_locally
	let count = $state(start);
</script>

<div class="island" data-counter>
	<strong>{label}</strong>:
	<button onclick={() => (count += 1)}>count is {count}</button>
</div>
