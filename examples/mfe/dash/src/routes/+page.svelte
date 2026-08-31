<script lang="ts">
	// Dash's own home page — proves the fragment component ALSO works as a normal page
	// in its own app (one component, two lives).
	import Kpis from '$lib/Kpis.svelte';
</script>

<h1>mfe-dash (standalone)</h1>
<Kpis org="acme" />
