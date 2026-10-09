<script lang="ts">
	// The twin WITHOUT a `$page` reader: no seed ships, so no props may reference it — every block
	// carries a full copy, exactly as before.
	import BlockCard from '$lib/seed-refs/BlockCard.svelte' with { wake: 'load' };
	let { data } = $props();
</script>

<h1 data-static-shell>{data.catalog.title} (no seed)</h1>
<p><a href="/seed-refs" data-to-seed>to the seeded twin</a></p>

{#each data.catalog.blocks as block (block.id)}
	<BlockCard {block} mode="identity" />
{/each}

<p data-after-islands>content after the islands</p>
