<script lang="ts">
	import '$lib/styles/widget.css';

	let { label = 'Counter', start = 0 }: { label?: string; start?: number } = $props();

	// svelte-ignore state_referenced_locally
	let count = $state(start);
</script>

<div class="widget" data-counter>
	<span class="widget-label">{label}</span>
	<div class="widget-row">
		<span class="widget-value">{count}</span>
		<button type="button" onclick={() => (count += 1)}>Increment</button>
	</div>
	<p class="widget-meta">The only block on this page that ships JS.</p>
</div>
