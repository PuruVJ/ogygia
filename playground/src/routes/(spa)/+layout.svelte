<script lang="ts">
	// This layout opts into the SPA router (+ view transitions) via <Router/>.
	import { Router } from 'ogygia';
	let { children } = $props();
</script>

<Router />

<nav>
	<a href="/">Home</a>
	<a href="/about">About</a>
	<a href="/data">Data</a>
	<a href="/server">Server</a>
	<a href="/defer-hydrate">Defer+hydrate</a>
	<a href="/nested">Nested</a>
	<a href="/ctx-nav" data-ctx-nav-link>Ctx nav</a>
	<a href="/static">Prerendered</a>
	<a href="/forms">Forms</a>
	<a href="/dashboard/orders">Dashboard</a>
	<a href="/plain">Plain (no router)</a>
</nav>
<hr />
{@render children()}
