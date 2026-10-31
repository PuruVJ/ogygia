<script lang="ts">
	// The page = the layout island's slot content. Has its OWN island to prove nested islands inside
	// the adopted slot still hydrate.
	import BootPageIsland from '$lib/BootPageIsland.svelte' with { wake: 'load' };
</script>

<h1 data-static-shell>Boot layout page (slot content)</h1>
<BootPageIsland />
