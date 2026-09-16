<script lang="ts">
	// A counter whose markup has whitespace-only text nodes between its elements — the node shape a
	// customer's design-system runtime edited inside sleeping islands (it removed exactly those).
	// island-foreign-edit + e2e/island-foreign-edit.spec.ts.
	import type { Snippet } from 'svelte';
	let {
		start = 0,
		label = 'Counter'
	}: { start?: number; label?: string; ogygiaFallback?: Snippet } = $props();
	// svelte-ignore state_referenced_locally
	let count = $state(start);
</script>

<div class="island" data-spaced-counter>
	<strong>{label}</strong>
	<span>:</span>
	<button onclick={() => (count += 1)}>count is {count}</button>
</div>
