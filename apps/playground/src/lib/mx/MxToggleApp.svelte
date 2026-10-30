<script lang="ts">
	// An island that can hide and show the page-authored snippet it renders: showing it again
	// re-creates the snippet's content in the browser.
	import type { Snippet } from 'svelte';
	let { blocks }: { blocks?: Snippet } = $props();
	let shown = $state(true);
</script>

<section>
	<button data-toggle onclick={() => (shown = !shown)}>toggle</button>
	{#if shown}{@render blocks?.()}{/if}
</section>
