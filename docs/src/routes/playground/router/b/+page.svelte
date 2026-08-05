<script lang="ts">
	import RouteProbe from '$lib/playground/RouteProbe.svelte' with { hydrate: 'load' };
</script>

<h2 style="view-transition-name: pg-router-title;">Page B</h2>
<div class="prose" style="margin-bottom: 2rem;">
	<p>
		Another SPA target. Same island, mounted again with a new id. Nothing about this page loaded a
		fresh document — the router fetched its HTML and swapped it in, then this island's chunk
		connected.
	</p>
</div>

<RouteProbe />
