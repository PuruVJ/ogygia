<script lang="ts">
	import '$lib/styles/widget.css';

	// Proves SPA remount + `$app/state` shim: mount id changes on nav, and `page.url.pathname`
	// is read from the island shim (real URL via `$state.raw`, not a deep-proxied URL / Kit
	// placeholder with empty pathname).
	import { page } from '$app/state';

	const mountId = Math.random().toString(36).slice(2, 7);
	let clicks = $state(0);
	const path = $derived(page.url.pathname);
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
