<script lang="ts">
	// PLANTED duplicate-module, the other half: the same catalog by its dist path.
	import { CATALOG } from '$lib/dup-pkg/dist/catalog.js';
	let i = $state(0);
</script>

<button data-dt="dup-pick" onclick={() => (i = (i + 1) % CATALOG.length)}>pick: {CATALOG[i].title}</button>
