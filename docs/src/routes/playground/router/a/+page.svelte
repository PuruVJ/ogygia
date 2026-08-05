<script lang="ts">
	import RouteProbe from '$lib/playground/RouteProbe.svelte' with { hydrate: 'load' };
</script>

<h2 style="view-transition-name: pg-router-title;">Page A</h2>
<div class="prose" style="margin-bottom: 2rem;">
	<p>
		You arrived here via a client-side swap (unless you loaded this URL directly). The route probe
		below mounted fresh for this page. The persist probe in the chrome above did not — its mount id
		and clicks carry over. Head to Page B or the hub and compare.
	</p>
</div>

<RouteProbe />
