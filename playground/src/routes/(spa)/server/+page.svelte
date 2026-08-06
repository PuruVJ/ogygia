<script lang="ts">
	// Server island: rendered on the server on demand, streamed in after the page.
	// The reserved `ogygiaFallback` snippet shows immediately; the component itself is NOT
	// rendered at page-SSR time.
	import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };
</script>

<h1 data-static-shell>Server islands</h1>
<p data-static-shell>
	The greeting below is a server island. Its <code>ogygiaFallback</code> renders in the initial HTML; the runtime
	then fetches the rendered component from <code>/_islands</code> (cookie-personalized, slow data)
	and swaps it in. No component JS ships to the browser.
</p>

<Greeting salutation="Hello">
	{#snippet ogygiaFallback()}
		<p class="fallback" data-fallback>loading greeting…</p>
	{/snippet}
</Greeting>

<style>
	.fallback {
		padding: 12px 16px;
		border: 2px dashed #999;
		border-radius: 8px;
		color: #666;
	}
</style>
