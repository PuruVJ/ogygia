<script>
	// This layout opts into the SPA router (+ view transitions) via <ClientRouter/>.
	import { ClientRouter } from 'sk-islands';
	let { children } = $props();
</script>

<ClientRouter />

<nav>
	<a href="/">Home</a>
	<a href="/about">About</a>
	<a href="/data">Data</a>
	<a href="/server">Server</a>
	<a href="/dashboard/orders">Dashboard</a>
	<a href="/plain">Plain (no router)</a>
</nav>
<hr />
{@render children()}
