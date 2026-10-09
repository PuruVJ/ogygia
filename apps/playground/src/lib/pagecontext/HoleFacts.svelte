<script lang="ts">
	// A hole whose tree reads `page.data`: rendered in the islands endpoint's request, for this page.
	import type { Snippet } from 'svelte';
	import FactsCard from './FactsCard.svelte';
	let {}: { ogygiaFallback?: Snippet } = $props();
</script>

<FactsCard kind="hole" />
