<script lang="ts">
	// PLANTED recovered, the SAME tree: its block takes the other branch in the browser, and both
	// branches draw the same thing — Svelte throws the server DOM away over a marker, and the markup
	// that comes back is the markup it threw away. No line of its drew another tree.
	const server = typeof window === 'undefined';
	let n = $state(0);
</script>

{#if server}
	<button data-dt="same-tree" onclick={() => (n += 1)}>same either way {n}</button>
{:else}
	<button data-dt="same-tree" onclick={() => (n += 1)}>same either way {n}</button>
{/if}
