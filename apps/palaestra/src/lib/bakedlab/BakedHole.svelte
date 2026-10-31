<script lang="ts">
	// A hole inside the baked region: fetched per visitor after load.
	import type { Snippet } from 'svelte';
	let {}: { ogygiaFallback?: Snippet } = $props();
</script>

<span data-bk-hole>account</span>
