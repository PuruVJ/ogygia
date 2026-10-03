<script lang="ts">
	// PLANTED duplicate-module, one half: the catalog by its source path (the other half, DupPick,
	// imports its dist twin — /dt-dupe loads both copies).
	import { search_catalog } from '$lib/dup-pkg/src/catalog';
	let q = $state('');
	const hits = $derived(q ? search_catalog(q) : []);
</script>

<label>search the catalog <input bind:value={q} data-dt="dup-search" /></label>
<p>{hits.length} found</p>
