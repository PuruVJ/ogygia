<script lang="ts">
	// The shelf island, fixed: it reads the one key it shows by name, so only that key ships.
	import { page } from '$app/state';
	const items = (page.data.shelf ?? []) as { id: string; name: string; price: number }[];
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
