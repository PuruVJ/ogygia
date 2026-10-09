<script lang="ts">
	// PLANTED forced layout in a click handler: each row's height is read right after the row before
	// it was changed, so the browser lays the list out again for every row. The devtools must say how
	// much of the handler was that, with the read-then-write fix (/dt-inp's SlowSave, a busy loop, never).
	let list: HTMLUListElement;
	let sorted = $state(0);
	function sort() {
		const rows = [...list.children] as HTMLElement[];
		for (let round = 0; round < 14; round++)
			for (const row of rows) {
				row.style.paddingTop = `${(round + row.offsetHeight) % 7}px`;
			}
		sorted++;
	}
</script>

<button data-inp="thrash" onclick={sort}>Sort</button>
<span data-inp-sorted>{sorted}</span>
<ul bind:this={list}>
	{#each Array.from({ length: 400 }, (_, i) => i) as i (i)}
		<li>row {i}</li>
	{/each}
</ul>
