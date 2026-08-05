<script lang="ts">
	// This route is NOT under <OgygiaRouter/>, so navigation here is a real document
	// load (MPA). Islands still hydrate — only client-side routing is opt-in.
	import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
</script>

<!-- Full site nav, but as PLAIN MPA links: /plain is not under <OgygiaRouter/>, so each click is
     a real document load. Landing on a (spa) route re-enables client-side routing from there. -->
<nav>
	<a href="/">Home</a>
	<a href="/about">About</a>
	<a href="/data">Data</a>
	<a href="/server">Server</a>
	<a href="/nested">Nested</a>
	<a href="/static">Prerendered</a>
	<a href="/forms">Forms</a>
	<a href="/dashboard/orders">Dashboard</a>
	<a href="/plain">Plain (no router)</a>
</nav>
<hr />
<h1 data-static-shell>Plain page (no OgygiaRouter)</h1>
<p data-static-shell>Links here trigger real document navigations. The island below still hydrates.</p>

<Counter start={5} label="Plain-page counter" />
