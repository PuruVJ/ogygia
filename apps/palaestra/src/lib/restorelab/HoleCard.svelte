<script lang="ts">
	// THE RESTORE LAB's hole: its answer holds a component host with an island inside, restored before
	// the answer goes in (before the island's copy of its markup, before it hydrates).
	import type { Snippet } from 'svelte';
	import HoleCount from './HoleCount.svelte' with { wake: 'load' };
	let {}: { ogygiaFallback?: Snippet } = $props();
</script>

<demo-card data-hole-card>
	<HoleCount />
</demo-card>
