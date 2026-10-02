<script lang="ts">
	// /dt-dom's twin: the same ~3,600 elements as plain page markup, no island. The devtools name the
	// page's size, never an island holding it.
	const items = Array.from({ length: 1200 }, (_, i) => ({ id: i, name: `item ${i}`, price: (i * 7) % 100 }));
</script>

<h1>element-count lab, static</h1>
<ul class="dense">
	{#each items as it (it.id)}
		<li><span>{it.name}</span><b>{it.price}</b></li>
	{/each}
</ul>
