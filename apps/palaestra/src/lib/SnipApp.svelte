<script lang="ts">
	// An island that renders a page-authored snippet (`blocks`) inside its own tree. The page's
	// snippet crosses live: its body hydrates with this island.
	import type { Snippet } from 'svelte';
	let { blocks }: { blocks?: Snippet } = $props();
	let n = $state(0);
</script>

<section data-snip-app>
	<button data-snip-app-btn onclick={() => (n += 1)}>app <span data-snip-app-n>{n}</span></button>
	{@render blocks?.()}
</section>
