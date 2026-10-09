<script lang="ts">
	// PLANTED recovered, ANOTHER tree: its block reads `typeof window` and draws different markup in
	// the browser — the component's own line is the cause, and the finding names it.
	const server = typeof window === 'undefined';
</script>

{#if server}
	<p data-dt="diff-tree">drawn by the server</p>
{:else}
	<p data-dt="diff-tree">drawn by the browser</p>
{/if}
