<script lang="ts">
	// THE SHAPE UNDER TEST: the root layout declares NO csr anywhere in its own chain —
	// `csr = false` lives only in the deep catch-all below. Its chrome islands must still
	// island on those pages (PAGE-CSR invariant: a layout derives its world from the pages
	// it serves, never from its own partial chain).
	import Header from '$lib/Header.svelte' with { wake: 'load' };
	import Boot from '$lib/Boot.svelte' with { wake: 'load' };
	let { children } = $props();
</script>

<Header />
<Boot />
<main>{@render children?.()}</main>
