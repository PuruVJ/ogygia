<script lang="ts">
	// The duplicate-module DECOY: only one copy of the catalog on this page (the build still holds
	// both, /dt-dupe loads the other) — nothing loads twice here.
	import DupSearch from '$lib/dtlab/DupSearch.svelte' with { wake: 'load' };
</script>

<h1>one module, one copy</h1>
<DupSearch />
