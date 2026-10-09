<script lang="ts">
	// /dt-big-hero: the page's largest paint, rendered by a different branch in the browser — so
	// hydration takes the server's heading out and puts its own in. The hero paints twice: the
	// devtools must say so (lcp-repaint), proven by the heading being replaced.
	const in_browser = typeof window !== 'undefined';
</script>

{#if in_browser}
	<h1 class="hero" data-side="browser">A big welcome for every visitor of this page</h1>
{:else}
	<h1 class="hero" data-side="server">A big welcome for every visitor of this page</h1>
{/if}

<style>
	.hero {
		font-size: 64px;
		line-height: 1.1;
		margin: 0 0 24px;
	}
</style>
