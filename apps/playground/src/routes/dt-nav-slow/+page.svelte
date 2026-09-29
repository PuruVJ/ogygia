<script lang="ts">
	// The slow page of the navigation lab: its server load is the wait; one island wakes after it shows.
	import Healthy from '$lib/dtlab/Healthy.svelte' with { wake: 'load' };
</script>

<h1 data-nav-page="slow">slow page</h1>
<a data-nav-go="fast" href="/dt-nav-fast">to the fast page</a>
<Healthy />
