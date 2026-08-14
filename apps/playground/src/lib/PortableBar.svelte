<script lang="ts">
	// An island that receives a snippet it did NOT author — the page's `actions`, forwarded through a
	// plain (non-island) shell. The snippet crosses the boundary as a portable descriptor and comes
	// alive here (any interactive island inside it hydrates).
	import type { Snippet } from 'svelte';
	let { actions }: { actions?: Snippet } = $props();
</script>

<footer class="island" data-portable-bar>
	bar:{#if actions}{@render actions()}{/if}
</footer>
