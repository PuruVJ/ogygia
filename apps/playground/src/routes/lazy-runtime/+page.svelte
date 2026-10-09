<script lang="ts">
	// LAZY RUNTIME CHUNKS (e2e/lazy-chunks.spec.ts): a page whose islands wake on `interaction` and
	// `visible` only. At boot the runtime must fetch NEITHER the hydrate core (Svelte's client
	// runtime, the props parse) NOR the navigation — those arrive with the first wake / the first
	// prefetch. The visible island sits far below the fold so a scroll is the wake.
	import InteractionCounter from '$lib/InteractionCounter.svelte' with { wake: 'interaction' };
	import Counter from '$lib/Counter.svelte' with { wake: 'visible' };
</script>

<h1 data-static-shell>Lazy runtime</h1>
<p data-static-shell>Nothing on this page hydrates until you use it or scroll to it.</p>

<InteractionCounter />

<div style="height: 3000px" data-spacer></div>

<Counter label="below the fold" start={5} />

<p><a href="/about" data-prefetch-link data-sveltekit-preload-data="hover">about</a></p>
