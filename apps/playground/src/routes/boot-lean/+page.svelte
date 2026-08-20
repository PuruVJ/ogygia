<script lang="ts">
	// A page island that reads the layout's context (currentDir) and the shared store the headless boot
	// island writes — proving both cross even though the layout itself ran no client script.
	import BootPageIsland from '$lib/BootPageIsland.svelte' with { wake: 'load' };
</script>

<h1 data-static-shell>Boot-lean page (normal layout + headless boot island)</h1>
<BootPageIsland />
