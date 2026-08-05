<script>
	// Public annotation wrapper: renders children only. No DOM, no nested-island context,
	// no region attrs. For source clarity around a region usage — not LakeBoundary (internal)
	// and not <svelte:boundary>.
	let { children } = $props();
</script>

{@render children?.()}
