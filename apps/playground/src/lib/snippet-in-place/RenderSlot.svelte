<script lang="ts">
	// A PLAIN component (not an island) that renders the snippet it is handed, in its own tree — the
	// shape of a design-system tabs / accordion. The compiler brands a zero-arg snippet passed here
	// (it MIGHT forward it into an island); rendered here it must still run in place.
	import type { Snippet } from 'svelte';
	let { content }: { content: Snippet } = $props();
</script>

<div data-render-slot>{@render content()}</div>
