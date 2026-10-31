<script lang="ts">
	// The SPA router is global, so navigation here is still client-side. This page opts OUT of view
	// transitions with `<meta name="ogygia-router" content="plain">` — the per-page escape hatch. The
	// handle presence-checks the meta, so this page's tag wins over the global default.
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
</script>

<svelte:head>
	<meta name="ogygia-router" content="plain" />
</svelte:head>

<nav>
	<a href="/">Home</a>
	<a href="/about">About</a>
	<a href="/data">Data</a>
	<a href="/server">Server</a>
	<a href="/nested">Nested</a>
	<a href="/static">Prerendered</a>
	<a href="/forms">Forms</a>
	<a href="/dashboard/orders">Dashboard</a>
	<a href="/plain">Plain (no view transitions)</a>
</nav>
<hr />
<h1 data-static-shell>Plain page (no view transitions)</h1>
<p data-static-shell>
	The global SPA router still handles these links; this page just skips the View Transitions API. The
	island below hydrates as usual.
</p>

<Counter start={5} label="Plain-page counter" />
