<script lang="ts">
	// An island that OWNS head content (e2e/head-ownership.spec.ts): a JSON-LD block, a meta tag and a
	// reactive title. On a csr=false page it re-renders its head fresh when it wakes, next to the
	// server's copy of the same content.
	let n = $state(0);
	const LD = '<script type="application/ld+json" data-head-island>{"@type":"BreadcrumbList"}</' + 'script>';
</script>

<svelte:head>
	{@html LD}
	<meta name="head-island" content="owned" />
	<title>Head island {n}</title>
</svelte:head>

<button data-head-island-btn onclick={() => n++}>clicks {n}</button>
