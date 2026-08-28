<script lang="ts">
	// A library component from a DECLARED `ogygia.files` package. The app imports Panel PLAIN —
	// the island inside it (Tally, `wake: 'load'`) is marked in the PACKAGE's own source, put on
	// the compile surface by its package.json declaration, not by anything in this app.
	import Panel from 'repro-island-pkg/Panel.svelte';
</script>

<h1 data-static-shell>Declared-package island host</h1>
<Panel />
