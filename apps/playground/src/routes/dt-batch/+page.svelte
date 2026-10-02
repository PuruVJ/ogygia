<script lang="ts">
	// THE BATCH LAB for the devtools answer key: four holes on the first screen that wake together
	// (`visible`), so they go out as ONE batch request; the fourth is slow (1.2 s on the server).
	// With the `og-auth-wall=post` cookie, something in front of ogygia refuses the batch (405): every
	// hole then fetches on its own — the devtools must name the refused batch and what it cost.
	import BatchHole from '$lib/dtholes/BatchHole.svelte' with { render: 'deferred', wake: 'visible' };
</script>

<h1>batch lab</h1>
{#each [1, 2, 3, 4] as n (n)}
	<BatchHole {n} slow={n === 4}>
		{#snippet ogygiaFallback()}<p data-hole="batch-{n}">loading batched hole {n}…</p>{/snippet}
	</BatchHole>
{/each}
