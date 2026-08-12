<script lang="ts">
	import '$lib/styles/widget.css';
	// A frozen lake inside this hydrated island. FrozenCounter ships in NO client chunk — its DOM is
	// lifted out and restored around this island's hydration. The counter above stays interactive.
	import FrozenCounter from './FrozenCounter.svelte' with { wake: 'none' };

	let count = $state(0);
</script>

<div class="widget">
	<span class="widget-label">Island · hydrated</span>
	<div class="widget-row">
		<span class="widget-value">{count}</span>
		<button type="button" onclick={() => (count += 1)}>Increment</button>
	</div>
	<p class="widget-meta">The snapshot below is a lake — frozen, ships no JS.</p>
	<FrozenCounter start={42} note="wake: 'none' · lifted &amp; restored" />
</div>
