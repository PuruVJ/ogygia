<script lang="ts">
	// Island host for the live-partial showcase. It never imports LiveTick — it paints whatever the
	// live query streams. `.current` holds the latest tick; `<Region>` swaps it in (no fetch) and
	// morphs each subsequent tick in place.
	import { onMount } from 'svelte';
	import { Region } from 'ogygia';
	import { liveTick } from './live.remote';

	// Start the live stream in the browser only, so this demo is safe on prerendered doc pages too
	// (a live query can't run during prerender SSR). The homepage keeps working unchanged.
	let tick = $state<ReturnType<typeof liveTick> | null>(null);
	onMount(() => {
		tick = liveTick();
	});
</script>

<div class="live-demo">
	{#if tick?.current}
		<Region of={tick.current} />
	{:else}
		<p class="widget-meta">connecting…</p>
	{/if}
	<p class="widget-meta">server pushes rendered HTML · no client data code</p>
</div>

<style>
	.live-demo {
		display: grid;
		gap: 0.5rem;
	}
</style>
