<script lang="ts">
	import RouteProbe from '$lib/playground/RouteProbe.svelte' with { hydrate: 'load' };
</script>

<h2 style="view-transition-name: pg-router-title;">MPA handoff</h2>
<div class="prose" style="margin-bottom: 2rem;">
	<p>
		The link that brought you here carries <code>data-sveltekit-reload</code>, so the router
		deliberately stepped aside and let the browser do a full document load. No body swap, no view
		transition — a real navigation. This is how you opt out of the SPA on a per-link basis; the same
		happens automatically for cross-origin links, downloads, and pages with no
		<code>&lt;ClientRouter /&gt;</code>.
	</p>
	<p>
		The island still hydrates on this freshly loaded document — client-side <em>routing</em> is what
		is opt-in, not islands. From here, the sub-nav links resume client-side swaps.
	</p>
</div>

<RouteProbe />
