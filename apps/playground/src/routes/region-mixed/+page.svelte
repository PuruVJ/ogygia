<script lang="ts">
	// csr=false (inherited from the root layout): RegionInside is used as an ISLAND here.
	import RegionInside from '$lib/mixed-region/RegionInside.svelte' with { wake: 'load' };
</script>

<nav><a href="/">Home</a> <a href="/kit">Kit page</a></nav>
<hr />
<h1 data-static-shell>region-mixed (csr = false) — RegionInside as an island</h1>
<RegionInside start={5} />
