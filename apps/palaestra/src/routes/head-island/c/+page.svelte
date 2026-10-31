<script lang="ts">
	// HEAD OWNERSHIP, page C: the same island as A (kept live across the navigation) — its head
	// content must stay exactly once.
	import HeadIsland from '$lib/HeadIsland.svelte' with { wake: 'load' };
</script>

<svelte:head>
	<meta name="description" content="page C" />
</svelte:head>

<h1 data-head-page="c">Head island C</h1>
<HeadIsland />
