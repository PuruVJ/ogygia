<script lang="ts">
	// A small island that proves an SPA swap really happened: it stamps a fresh mount id each time it
	// mounts, and reads the live path after mount. Islands remount on every navigation, so both the
	// mount id and the path change when you move between router pages — there is no cross-navigation
	// island state.
	const mountId = Math.random().toString(36).slice(2, 7);
	let clicks = $state(0);

	// Read the path on the client after mount. SSR and the initial hydration render both show the
	// placeholder, so there is no hydration mismatch; the effect then fills in the real path.
	let path = $state('…');
	$effect(() => {
		path = location.pathname;
	});
</script>

<div class="widget" data-route-probe style="max-width: 340px;">
	<span class="widget-label">route probe</span>
	<p class="widget-meta" data-path style="margin-top: 0;">path: {path}</p>
	<p class="widget-meta" data-mount>mount id: {mountId}</p>
	<div class="widget-row" style="margin-top: 0.5rem;">
		<span class="widget-value" data-clicks>{clicks}</span>
		<button type="button" data-click onclick={() => (clicks += 1)}>click +1</button>
	</div>
</div>
