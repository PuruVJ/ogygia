<script lang="ts">
	// PLAIN TWIN of ../+page.svelte: identical markup, no marked imports → no islands, no props
	// sidecars, no seed, no region fingerprints. Whatever ../ costs above this route is ogygia.
	import BenchBlock from '$lib/bench/BenchBlock.svelte';
	import BenchHeader from '$lib/bench/BenchHeader.svelte';
	import { header_config } from '$lib/bench/data';
	let { data } = $props();
</script>

<svelte:head><title>bench: CMS shape (plain)</title></svelte:head>

<BenchHeader config={header_config} />
<h1 data-static-shell>{data.catalog.title}</h1>
<p data-page-greeting>{data.greeting}</p>

{#each data.catalog.blocks as block (block.id)}
	<BenchBlock {block} />
{/each}

<p data-after-islands>content after the islands</p>
