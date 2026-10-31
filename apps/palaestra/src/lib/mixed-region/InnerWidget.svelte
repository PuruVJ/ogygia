<script lang="ts">
	// The interactive component the held region wraps. Its own click state proves hydration.
	let { start = 0, label = 'inner' }: { start?: number; label?: string } = $props();
	// svelte-ignore state_referenced_locally
	let n = $state(start);
</script>

<button data-inner-widget onclick={() => (n += 1)}>{label} count is {n}</button>
