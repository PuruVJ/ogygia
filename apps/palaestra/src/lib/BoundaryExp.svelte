<script lang="ts">
	// Runs as an ISLAND (placed with wake:'load'), so its script is live on the client.
	// Measurement harness for the ownership model ("a region's loading UI lives on the region"):
	//   A — ANTI-PATTERN: `of={await …}` in a <svelte:boundary>. Its pending covers only the fetch;
	//       the paint (CSS) happens after the boundary un-suspends. The runtime's never-unstyled
	//       guarantee turns that into an empty hold rather than a flash — but the gap is real.
	//   B — THE MODEL: `of={promise}` + `placeholder`. One indicator across fetch AND styled paint.
	import { Region } from 'ogygia';
	import { boxSearch } from '$lib/box-search.remote';

	let qa = $state<string | null>(null);
	let qb = $state<string | null>(null);
</script>

<section class="exp" data-exp="boundary">
	<h2>A — boundary + await</h2>
	<button onclick={() => (qa = 'a-' + Date.now())}>Search A</button>
	{#if qa}
		<svelte:boundary>
			<Region of={await boxSearch(qa)} />
			{#snippet pending()}<p class="ph" data-a-pending>Boundary pending…</p>{/snippet}
		</svelte:boundary>
	{/if}
</section>

<section class="exp" data-exp="placeholder">
	<h2>B — placeholder snippet</h2>
	<button onclick={() => (qb = 'b-' + Date.now())}>Search B</button>
	{#if qb}
		<Region of={boxSearch(qb)}>
			{#snippet placeholder()}<p class="ph" data-b-pending>Placeholder…</p>{/snippet}
		</Region>
	{/if}
</section>

<style>
	.exp { margin: 1.5rem 0; }
	.ph { opacity: 0.6; }
</style>
