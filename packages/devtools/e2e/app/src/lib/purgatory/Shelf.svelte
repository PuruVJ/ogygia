<script lang="ts">
	// An island that shows the shelf. It reads page.data only through `shelfOf` (./shelf.ts).
	import { shelfOf } from './shelf';
	const items = shelfOf();
	let open = $state(false);
</script>

<section data-shelf>
	<button onclick={() => (open = !open)}>{items.length} on the shelf</button>
	{#if open}
		<ul>
			{#each items as item (item.id)}
				<li>{item.name} · {item.price}</li>
			{/each}
		</ul>
	{/if}
</section>
