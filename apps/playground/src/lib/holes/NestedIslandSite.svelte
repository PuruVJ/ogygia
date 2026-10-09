<script lang="ts">
	// A hydrate-ISLAND call site that renders a PARAMETERIZED snippet: at an island site any arity
	// crosses (a plain site only takes 0-arg snippets), so this exercises the other candidate branch.
	import type { Snippet } from 'svelte';
	let { item }: { item?: Snippet<[number]> } = $props();
</script>

<ul data-nested-island-site>
	{#each [1, 2] as n (n)}<li>{#if item}{@render item(n)}{/if}</li>{/each}
</ul>
