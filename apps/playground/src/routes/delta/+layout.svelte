<script>
	// DeltaNav is imported the same way in the shared layout → identical entry + props on both routes
	// → identical fingerprint → the server skips it on an SPA nav between /delta/a and /delta/b.
	import DeltaNav from '$lib/DeltaNav.svelte' with { wake: 'load' };
	let { children } = $props();
</script>

<DeltaNav />
{@render children()}
