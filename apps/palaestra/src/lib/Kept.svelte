<script lang="ts">
	// A server island that ALWAYS answers keepFallback(): the page's fallback stands (204, no swap).
	// Its fallback carries a `wake: 'interaction'` island — the regression the lake-kit suite guards:
	// an island inside a server island's `ogygiaFallback` must be a REAL region so it can wake after
	// the fallback is kept (it was once flattened to an inline component and never woke).
	import type { Snippet } from 'svelte';
	import { keepFallback } from 'ogygia';

	let { ogygiaFallback }: { ogygiaFallback?: Snippet } = $props();

	keepFallback();
</script>

<p data-kept-never>never rendered — the fallback is kept</p>
