<script lang="ts">
	// The page shell is static (csr=false). The interactive experiment is an island.
	import BoundaryExp from '$lib/BoundaryExp.svelte' with { wake: 'load' };
</script>

<h1 data-static-shell>Boundary vs placeholder</h1>
<p data-static-shell>Two ways to show "not ready" for a client-fetched held region.</p>

<BoundaryExp />
