<script lang="ts">
	// /dt-dom: 1,200 rows of three elements each, all inside this island — it hydrates over every
	// one of them. The devtools must name it as holding most of the page's elements.
	let { rows }: { rows: number } = $props();
	const items = Array.from({ length: rows }, (_, i) => ({ id: i, name: `item ${i}`, price: (i * 7) % 100 }));
</script>

<ul class="dense">
	{#each items as it (it.id)}
		<li><span>{it.name}</span><b>{it.price}</b></li>
	{/each}
</ul>
