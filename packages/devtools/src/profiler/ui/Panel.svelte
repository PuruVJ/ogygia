<script lang="ts">
	/**
	 * One dashboard panel: a card with a title, an optional sub-line in the title, and whatever the
	 * section renders inside. Static — every section of the report sits in one, so the page reads as
	 * a grid of cards instead of a scroll of headings. `wide` spans a two-column row.
	 */
	import type { Snippet } from 'svelte';
	let { id, title, sub = '', wide = false, children }: { id: string; title: string; sub?: string; wide?: boolean; children: Snippet } = $props();
</script>

<section class="panel" class:wide {id}>
	<h2>{title}{#if sub}<span class="hint">{sub}</span>{/if}</h2>
	{@render children()}
</section>
