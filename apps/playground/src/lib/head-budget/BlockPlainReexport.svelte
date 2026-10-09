<script lang="ts">
	let { label = 'block plain-reexport' }: { label?: string } = $props();
</script>

<!-- A PLAIN registry import (no `with`): server-rendered, never a region. Its CSS reaches a
     csr=false page only through the page node's client graph (e2e/head-budget). -->
<h2 class="hb-plain-reexport" data-hb-plain="plain-reexport">{label}</h2>

<style>
	.hb-plain-reexport {
		--og-hb-token: hbtoken-plain-reexport;
		font-size: 40px;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
