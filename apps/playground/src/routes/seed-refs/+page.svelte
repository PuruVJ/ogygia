<script lang="ts">
	// SEED REFERENCES (e2e/seed-refs.spec.ts). Twelve block islands fed from `data.catalog`:
	//   - even blocks: the seed's own object (identity)
	//   - odd blocks: a JSON clone (what a CMS SDK hands out — structure only)
	// plus one `$page` reader, so the seed ships. Every block's props must serialize as a reference.
	import BlockCard from '$lib/seed-refs/BlockCard.svelte' with { wake: 'load' };
	import PageGreeting from '$lib/seed-refs/PageGreeting.svelte' with { wake: 'load' };
	let { data } = $props();
	const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
</script>

<h1 data-static-shell>{data.catalog.title}</h1>
<PageGreeting />
<p><a href="/seed-refs/noseed" data-to-noseed>to the no-seed twin</a></p>

{#each data.catalog.blocks as block, i (block.id)}
	{#if i % 2 === 0}
		<BlockCard {block} mode="identity" />
	{:else}
		<BlockCard block={clone(block)} mode="clone" />
	{/if}
{/each}

<p data-after-islands>content after the islands</p>
