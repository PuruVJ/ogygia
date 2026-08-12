<script lang="ts">
	import '$lib/styles/widget.css';

	let clicks = $state(0);
</script>

<div class="widget">
	<span class="widget-label">Visible island</span>
	<div class="widget-row">
		<span class="widget-value">{clicks}</span>
		<button type="button" onclick={() => (clicks += 1)}>Click</button>
	</div>
	<p class="widget-meta">Hydrated on intersect</p>
</div>
