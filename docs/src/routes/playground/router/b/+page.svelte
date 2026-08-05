<script lang="ts">
	import RouteProbe from '$lib/playground/RouteProbe.svelte' with { hydrate: 'load' };
</script>

<h2 style="view-transition-name: pg-router-title;">Page B</h2>
<div class="prose" style="margin-bottom: 2rem;">
	<p>
		Another SPA target. The route probe below remounted with a new id; the persist probe in the
		chrome above did not. Nothing about this page loaded a fresh document — the router fetched its
		HTML and swapped it in.
	</p>
</div>

<RouteProbe />
