<script lang="ts">
	// A deferred server island that opts INTO a browser cache via `maxAge` (preset cachedGreeting,
	// see vite.config.ts → { render: 'deferred', maxAge: '1h' }). Its signed endpoint carries a `ttl`
	// and the handle answers `private, max-age=3600`. Default holes are `no-store`; this proves the
	// opt-in path end to end. Exercised by verify/server-islands.ts.
	import CachedGreeting from '$lib/Greeting.svelte' with { preset: 'cachedGreeting' };
</script>

<h1 data-static-shell>Cached server island</h1>

<div data-cached-greeting>
	<CachedGreeting salutation="Cached">
		{#snippet ogygiaFallback()}
			<p data-cached-fallback>loading cached greeting…</p>
		{/snippet}
	</CachedGreeting>
</div>
