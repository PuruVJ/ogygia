<script lang="ts">
	// A counter whose markup has whitespace-only text nodes between its elements — the node shape a
	// customer's design-system runtime edited inside sleeping islands (it removed exactly those) —
	// and a foreign custom element (`<foreign-strip>`, defined by the island-foreign-edit page after
	// load) that does that stripping in its connect reaction, the way a design-system runtime's
	// client hydrate does: an island repaired by re-creating its nodes would trigger it again.
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
	<foreign-strip></foreign-strip>
	<strong>{label}</strong>
	<span>:</span>
	<button onclick={() => (count += 1)}>count is {count}</button>
</div>
