<script lang="ts">
	// A plain (unmarked) child that receives a snippet. Mirrors the real-world shape that bit us: the
	// hole hands a snippet containing a wake island to a shell component, which portable-izes it.
	import type { Snippet } from 'svelte';
	let { panel }: { panel?: Snippet } = $props();
</script>

<div data-nested-shell>{#if panel}{@render panel()}{/if}</div>
