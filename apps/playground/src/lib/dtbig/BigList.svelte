<script lang="ts">
	// /dt-big: ~40 KB of markup, then an attribute made fresh on every render (server and browser
	// differ there, ~38 KB in). The devtools must quote THAT difference — not the place a 24 KB copy
	// of the markup was cut.
	let { rows }: { rows: number } = $props();
	const items = Array.from({ length: rows }, (_, i) => ({ id: i, text: `row ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit` }));
	const track = Math.random().toString(16).slice(2, 10);
</script>

<ul>
	{#each items as it (it.id)}
		<li data-row={it.id}>{it.text}</li>
	{/each}
</ul>
<aside data-track={track}>promotion</aside>
