<script>
	import Clock from '$lib/Clock.svelte' with { island: 'load' };
	import Counter from '$lib/Counter.svelte' with { island: 'visible' };
	import Marker from '$lib/Marker.svelte' with { island: 'load' };
</script>

<h1 data-static-shell>About</h1>
<p data-static-shell>Different page, more islands. Navigating here from Home is a SPA swap.</p>

<Clock />

<Counter start={100} label="Import-attribute counter (visible)" />

<Marker />

<p><a href="/">Back home</a> — click it to prove SPA nav keeps <code>window.__marker</code> stable.</p>
