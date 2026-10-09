<script lang="ts">
	// HEAD OWNERSHIP, page B: no head-owning island. Its own head tags must survive the navigation
	// from A, where the island that owned head content is torn down.
</script>

<svelte:head>
	<meta name="description" content="page B" />
	<link rel="canonical" href="https://example.test/head-island/b" />
	<meta property="og:title" content="page B" />
</svelte:head>

<h1 data-head-page="b">Head island B</h1>
