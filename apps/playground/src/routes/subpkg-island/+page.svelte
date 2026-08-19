<script lang="ts">
	// Imports an island HOST from a workspace sub-package (repro-subpkg) that does NOT depend on ogygia.
	// The build must resolve the injected `ogygia/internal` inside Toolbar.svelte via the plugin's
	// self-reference. Before the fix this failed: "Rolldown failed to resolve import 'ogygia/internal'".
	import Toolbar from 'repro-subpkg/Toolbar.svelte';
</script>

<h1 data-static-shell>Sub-package island host</h1>
<Toolbar />
