<script lang="ts">
	// A PLAIN (non-island) card that takes a `demo` snippet and renders it SAME-GRAPH — the
	// ShowcaseCard shape. On a csr=false page this card never hydrates, so any island inside the
	// snippet must survive as a real `<ogygia-region>` (compiler keeps its mark in the portable
	// entry) and wake itself; an awaiting island must SSR through the async-threaded snippet render.
	import type { Snippet } from 'svelte';
	let { title, demo }: { title: string; demo: Snippet } = $props();
</script>

<section data-snippet-card>
	<h2>{title}</h2>
	<div data-snippet-stage>{@render demo()}</div>
</section>
