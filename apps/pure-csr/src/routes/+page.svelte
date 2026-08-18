<script lang="ts">
	import RegionInside from '$lib/RegionInside.svelte';
</script>

<h1 data-static-shell>pure csr = true app</h1>
<p data-static-shell>No route sets csr=false, so ogygia ships no runtime chunk.</p>
<RegionInside start={3} />
