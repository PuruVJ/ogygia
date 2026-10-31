<script lang="ts">
	// SERVER-COST BENCH: 20 block islands (half load, half visible) fed identity slices of the seed, a
	// header island with a ~300 KB config prop outside page.data, one `$page` reader. See +page.server.ts.
	import BlockLoad from '$lib/bench/BenchBlock.svelte' with { wake: 'load' };
	import BlockVisible from '$lib/bench/BenchBlock.svelte' with { wake: 'visible' };
	import BenchHeader from '$lib/bench/BenchHeader.svelte' with { wake: 'load' };
	import BenchPageReader from '$lib/bench/BenchPageReader.svelte' with { wake: 'load' };
	import { header_config } from '$lib/bench/data';
	let { data } = $props();
</script>

<svelte:head><title>bench: CMS shape (islands)</title></svelte:head>

<BenchHeader config={header_config} />
<h1 data-static-shell>{data.catalog.title}</h1>
<BenchPageReader />

{#each data.catalog.blocks as block, i (block.id)}
	{#if i % 2 === 0}
		<BlockLoad {block} />
	{:else}
		<BlockVisible {block} />
	{/if}
{/each}

<p data-after-islands>content after the islands</p>
