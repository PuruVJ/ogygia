<script lang="ts">
	// A plain container that renders the snippets it is given, in its own markup.
	import type { Snippet } from 'svelte';
	let { top, middle }: { top?: Snippet; middle?: Snippet } = $props();
</script>

<div data-slot-top>{@render top?.()}</div>
<p>between</p>
<div data-slot-middle>{@render middle?.()}</div>
