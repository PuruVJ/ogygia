<script>
	// A plain wrapper that FORWARDS its children into an island — the shape that used to 500
	// ("Cannot stringify a function"). Now the children freeze as a static region snippet.
	import Inner from './RSInner.svelte' with { wake: 'load' };
	let { children } = $props();
</script>

<Inner>{@render children()}</Inner>
