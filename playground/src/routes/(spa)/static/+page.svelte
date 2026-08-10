<script lang="ts">
	// Flagship: a fully PRERENDERED static page with a personalized SERVER-ISLAND hole.
	// - The counter is a normal island: SSR'd into the static file, hydrates from it.
	// - The greeting is a server island: the static file carries only its ogygiaFallback + a signed
	//   endpoint reference; at runtime the browser fetches the personalized HTML and swaps it in.
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	import Greeting from '$lib/Greeting.svelte' with { fill: 'load' };
</script>

<h1 data-static-shell>Prerendered page</h1>
<p data-static-shell>
	This page is prerendered to a static <code>.html</code> file at build time. It ships zero Kit
	JS, its counter island hydrates from the static file, and its greeting is a personalized
	server-island hole filled at runtime.
</p>

<Counter start={7} label="Prerendered counter" />

<div data-static-hole>
	<Greeting salutation="Welcome">
		{#snippet ogygiaFallback()}<p data-fallback>loading personalized greeting…</p>{/snippet}
	</Greeting>
</div>
