<script lang="ts">
	import '$lib/styles/widget.css';

	let clicks = $state(0);
</script>

<div class="widget">
	<span class="widget-label">Interaction island</span>
	<div class="widget-row">
		<span class="widget-value">{clicks}</span>
		<button type="button" onclick={() => (clicks += 1)}>Poke</button>
	</div>
	<p class="widget-meta">Hydrated on first poke</p>
</div>
