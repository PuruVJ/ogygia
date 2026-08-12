<script lang="ts">
	// The SPA router (+ view transitions) is global — enabled by the ogygia() vite plugin, no
	// component to render. `/plain` opts OUT of view transitions per-page via a meta tag.
	let { children } = $props();
</script>

<nav>
	<a href="/">Home</a>
	<a href="/about">About</a>
	<a href="/data">Data</a>
	<a href="/server">Server</a>
	<a href="/nested">Nested</a>
	<a href="/ctx-nav" data-ctx-nav-link>Ctx nav</a>
	<a href="/static">Prerendered</a>
	<a href="/forms">Forms</a>
	<a href="/dashboard/orders">Dashboard</a>
	<a href="/weave" data-weave-link data-ogygia-speculate="off">Weave</a>
	<a href="/ooo" data-ooo-link data-ogygia-speculate="off">OOO</a>
	<a href="/plain">Plain (no view transitions)</a>
</nav>
<hr />
{@render children()}
