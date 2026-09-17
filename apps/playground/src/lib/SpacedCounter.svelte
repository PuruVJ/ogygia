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
		label = 'Counter',
		sep = ':'
	}: { start?: number; label?: string; sep?: string; ogygiaFallback?: Snippet } = $props();
	// svelte-ignore state_referenced_locally
	let count = $state(start);
</script>

<!-- The customer's login trigger + dropdown shape: wrapped siblings with a DYNAMIC attribute on
     the inner element, whitespace between. On the edited sequence Svelte's walk lands one sibling
     later at every step (it skips two nodes where one was a space) and never checks a tag; when
     such a walk gets far enough its effects write `data-label` / `data-sep` onto the wrong
     elements (the customer's login trigger attributes landed on its dropdown wrapper). The runtime
     puts the sequence back BEFORE the walk; e2e asserts no element carries another element's. -->
<div class="island" data-spaced-counter>
	<foreign-strip></foreign-strip>
	<span class="label"><strong data-label={label}>{label}</strong></span>
	<span class="sep"><i data-sep={sep}>{sep}</i></span>
	<span class="count"><u data-count-of={label}>{count}</u></span>
	<button onclick={() => (count += 1)}>count is {count}</button>
</div>
