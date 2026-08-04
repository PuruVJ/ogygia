<script lang="ts">
	// This route is NOT under <ClientRouter/>, so navigation here is a real document
	// load (MPA). Islands still hydrate — only client-side routing is opt-in.
	import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
</script>

<nav>
	<a href="/">Home (full load)</a>
	<a href="/plain">Plain</a>
</nav>
<hr />
<h1 data-static-shell>Plain page (no ClientRouter)</h1>
<p data-static-shell>Links here trigger real document navigations. The island below still hydrates.</p>

<Counter start={5} label="Plain-page counter" />
