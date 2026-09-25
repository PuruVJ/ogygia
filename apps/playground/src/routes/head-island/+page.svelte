<script lang="ts">
	// HEAD OWNERSHIP (e2e/head-ownership.spec.ts), page A: a woken island owns head content.
	import HeadIsland from '$lib/HeadIsland.svelte' with { wake: 'load' };
</script>

<svelte:head>
	<meta name="description" content="page A" />
</svelte:head>

<h1 data-head-page="a">Head island A</h1>
<HeadIsland />
<p><a href="/head-island/b" data-to-b>to B (no island)</a></p>
<p><a href="/head-island/c" data-to-c>to C (same island)</a></p>
