<script lang="ts">
	import '$lib/styles/widget.css';

	// Lives inside `data-ogygia-persist` chrome in the router playground layout.
	// Mount id + click count survive SPA navigations; contrast with RouteProbe on each page.
	const mountId = Math.random().toString(36).slice(2, 7);
	let clicks = $state(0);
</script>

<div class="widget" data-persist-probe style="max-width: 340px; margin-top: 1rem;">
	<span class="widget-label">persist probe</span>
	<p class="widget-meta" data-mount style="margin-top: 0;">mount id: {mountId}</p>
	<div class="widget-row" style="margin-top: 0.5rem;">
		<span class="widget-value" data-clicks>{clicks}</span>
		<button type="button" data-click onclick={() => (clicks += 1)}>click +1</button>
	</div>
	<p class="widget-meta" style="margin-top: 0.5rem;">
		Survives SPA nav — this node is under <code>data-ogygia-persist</code>.
	</p>
</div>
