<script lang="ts">
	let { label = 'block plain' }: { label?: string } = $props();
</script>

<!-- A PLAIN registry import (no `with`): server-rendered, never a region. Its CSS reaches a
     csr=false page only through the page node's client graph (e2e/head-budget). -->
<h2 class="hb-plain" data-hb-plain="plain">{label}</h2>

<style>
	.hb-plain {
		--og-hb-token: hbtoken-plain;
		font-size: 40px;
		outline: 2px solid rgb(9, 176, 84);
	}
</style>
