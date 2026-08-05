<script lang="ts">
	import RouteProbe from '$lib/playground/RouteProbe.svelte' with { hydrate: 'load' };
</script>

<h2 style="view-transition-name: pg-router-title;">Page A</h2>
<div class="prose" style="margin-bottom: 2rem;">
	<p>
		You arrived here via a client-side swap (unless you loaded this URL directly). The probe below
		mounted fresh for this page. Head back to the hub or over to Page B and watch the mount id and
		path change again.
	</p>
</div>

<RouteProbe />
