<script lang="ts">
	let { start = 0, label = 'inner' }: { start?: number; label?: string } = $props();
	// svelte-ignore state_referenced_locally
	let n = $state(start);
</script>

<button data-inner-widget onclick={() => (n += 1)}>{label} count is {n}</button>
