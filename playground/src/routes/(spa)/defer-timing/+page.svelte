<script lang="ts">
	// Defer TIMING variants (server-island fetch scheduling, symmetric with hydrate timing).
	// Each hole fetches its rendered HTML from the island endpoint on a different schedule:
	//   load    -> immediately (a <link rel=preload> hint is emitted; only this variant preloads)
	//   idle    -> on requestIdleCallback
	//   visible -> when scrolled into view (IntersectionObserver) — placed far below the fold
	//   media   -> when the media query matches
	import GLoad from '$lib/Greeting.svelte' with { fill: 'load' };
	import GIdle from '$lib/Greeting.svelte' with { fill: 'idle' };
	import GVisible from '$lib/Greeting.svelte' with { fill: 'visible' };
	import GMedia from '$lib/Greeting.svelte' with { fill: '(min-width: 300px)' };
</script>

<h1 data-static-shell>Defer timing variants</h1>
<p data-static-shell>
	Four server-island holes, each fetching its HTML on a different schedule. Only <code>load</code>
	emits a preload hint; <code>visible</code> does not fetch until scrolled into view.
</p>

<section data-defer="load">
	<h2 data-static-shell>load</h2>
	<GLoad salutation="Load">{#snippet ogygiaFallback()}<p class="fb" data-fallback-load>loading (load)…</p>{/snippet}</GLoad>
</section>

<section data-defer="idle">
	<h2 data-static-shell>idle</h2>
	<GIdle salutation="Idle">{#snippet ogygiaFallback()}<p class="fb" data-fallback-idle>loading (idle)…</p>{/snippet}</GIdle>
</section>

<section data-defer="media">
	<h2 data-static-shell>media</h2>
	<GMedia salutation="Media">{#snippet ogygiaFallback()}<p class="fb" data-fallback-media>loading (media)…</p>{/snippet}</GMedia>
</section>

<!-- big spacer so the visible hole starts well below the fold -->
<div style="height: 2400px" data-static-shell aria-hidden="true"></div>

<section data-defer="visible">
	<h2 data-static-shell>visible (below the fold)</h2>
	<GVisible salutation="Visible">{#snippet ogygiaFallback()}<p class="fb" data-fallback-visible>loading (visible)…</p>{/snippet}</GVisible>
</section>

<style>
	.fb {
		padding: 8px 12px;
		border: 2px dashed #999;
		border-radius: 8px;
		color: #666;
	}
</style>
