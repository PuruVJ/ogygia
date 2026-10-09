<script lang="ts">
	// PURGATORY's page: every key the load returns is shown, so none reads as work for nothing.
	import Shelf from '$lib/purgatory/Shelf.svelte' with { wake: 'load' };
	let { data } = $props();
</script>

<Shelf />

<h1>Purgatory · {data.count} rows</h1>
<p>
	{data.tags} tags · {data.stamps} stamps · {data.sale} on sale · {data.flat} flat tags · q "{data.q}"
</p>
<p>{data.listed.join(', ')} · {data.cached.join(', ')}</p>
<p>{data.slugged} brand slugs · {data.inits.join(', ')} · {data.items} catalog items</p>
