<div class="widget">
	<span class="widget-label">Media island</span>
	<div class="widget-row">
		<span class="widget-value">{taps}</span>
		<button type="button" onclick={() => (taps += 1)}>Tap</button>
	</div>
	<p class="widget-meta">Active when {query}</p>
</div>

<script lang="ts">
	import '$lib/styles/widget.css';

	let { query = '(max-width: 600px)' }: { query?: string } = $props();
	let taps = $state(0);
</script>
