<script lang="ts">
	import '$lib/styles/widget.css';

	// Plain component — not an island. Lives in the host island's client chunk graph only after
	// `await import(...)` from OnDemandHost.
	let count = $state(0);
</script>

<div class="widget" data-on-demand-widget>
	<span class="widget-label">lazy regular component</span>
	<div class="widget-row">
		<span class="widget-value" data-count>{count}</span>
		<button type="button" data-inc onclick={() => (count += 1)}>Increment</button>
	</div>
	<p class="widget-meta">No hydrate attribute — just a child of the host island.</p>
</div>
