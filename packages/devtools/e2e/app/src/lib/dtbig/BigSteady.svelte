<script lang="ts">
	// /dt-big's decoy: the same ~40 KB of markup, the same on both sides.
	let { rows }: { rows: number } = $props();
	const items = Array.from({ length: rows }, (_, i) => ({ id: i, text: `row ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit` }));
</script>

<ul>
	{#each items as it (it.id)}
		<li data-row={it.id}>{it.text}</li>
	{/each}
</ul>
<aside data-track="steady">promotion</aside>
