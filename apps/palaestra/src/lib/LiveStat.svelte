<script lang="ts">
	// INTERACTIVE live-partial component. Rendered on the server each tick and hydrated once; on
	// later ticks the runtime PUSHES new props into this mounted instance (keep-alive) instead of
	// re-hydrating. The local `$state` counter proves that: clicking +1 survives across ticks — if
	// the island were torn down and re-hydrated per tick, the local count would reset to 0.
	let { value }: { value: number } = $props();

	let clicks = $state(0);
</script>

<div class="island" data-live-stat>
	<span data-stat-value>value: {value}</span>
	<button data-stat-clicks onclick={() => (clicks += 1)}>local clicks: {clicks}</button>
</div>

<style>
	/* REGRESSION (see e2e/live-partial.ts): a SCOPED style on a wire-delivered held-region
	   component. The page never statically imports LiveStat (the server picks it per tick), so its
	   CSS lands in NO page stylesheet — it must ride the region response as a `<link
	   data-ogygia-region-css>` the runtime hoists. A distinctive outline colour proves it loaded and
	   applied. This is exactly the CSS the `?og-region` module-id fork silently dropped. */
	[data-live-stat] {
		outline: 3px solid rgb(7, 113, 219);
	}
</style>
