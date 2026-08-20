<script lang="ts">
	let { start = 0, label = 'Raw' }: { start?: number; label?: string } = $props();
	// svelte-ignore state_referenced_locally
	let count = $state(start);
</script>

<div class="island" data-tsraw>
	<strong>{label}</strong>:
	<button onclick={() => (count += 1)}>r {count}</button>
</div>
