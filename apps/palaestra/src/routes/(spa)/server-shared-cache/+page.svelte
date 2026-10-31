<script lang="ts">
	// A server island on a page shared caches keep for 8 days (see +page.server.ts).
	import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };
</script>

<h1>Server island on a CDN-cached page</h1>

<Greeting salutation="Hello">
	{#snippet ogygiaFallback()}
		<p data-fallback>loading greeting…</p>
	{/snippet}
</Greeting>
