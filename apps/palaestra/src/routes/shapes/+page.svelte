<script lang="ts">
	// Static shell; the harness runs as an island (csr=false page).
	import ShapesExp from '$lib/ShapesExp.svelte' with { wake: 'load' };
</script>

<h1 data-static-shell>Wire-law shapes harness</h1>
<p data-static-shell>Each section crosses a different data shape whose leaves are regions.</p>

<ShapesExp />
