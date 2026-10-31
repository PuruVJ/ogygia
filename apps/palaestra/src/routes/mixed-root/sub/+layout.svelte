<script lang="ts">
	// csr=false host under a csr=true ancestor: before the reset fix, DynIsland inherited `true` and
	// rendered inline — zero <ogygia-region>. With the reset it islands + hydrates.
	import DynIsland from '$lib/DynIsland.svelte' with { wake: 'load' };
	let { children } = $props();
</script>
<div data-mixed-sub-layout><DynIsland /></div>
{@render children()}
