<script lang="ts">
	// csr=true: the SAME RegionInside component that is an island on /region-mixed, here used as a
	// PLAIN component. Kit hydrates the tree. Because RegionInside uses <Region> DIRECTLY (not the
	// `with { wake }` import sugar the csr=true transform strips), it still emits an <ogygia-region>
	// + runtime script here — and the runtime yields to Kit. See e2e/region-mixed.ts.
	import RegionInside from '$lib/mixed-region/RegionInside.svelte';
</script>

<nav><a href="/">Home</a> <a href="/region-mixed">csr=false version</a></nav>
<hr />
<h1 data-static-shell>region-mixed-kit (csr = true) — RegionInside as a plain component</h1>
<RegionInside start={7} />
