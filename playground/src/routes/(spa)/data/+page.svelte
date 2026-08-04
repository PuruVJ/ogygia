<script lang="ts">
	import ResolvedGreeting from '$lib/ResolvedGreeting.svelte' with { hydrate: 'load' };
	import PendingGreeting from '$lib/PendingGreeting.svelte' with { hydrate: 'load' };
	import RemoteCounter from '$lib/RemoteCounter.svelte' with { hydrate: 'load' };
	import LiveClock from '$lib/LiveClock.svelte' with { hydrate: 'load' };
	import TransportProbe from '$lib/TransportProbe.svelte' with { hydrate: 'load' };
</script>

<h1 data-static-shell>Data — remote functions inside islands</h1>
<p data-static-shell>
	These islands call SvelteKit remote functions (query with a validated arg, command, and a
	query.live stream) on the client. SSR runs them in-process; hydration re-fetches over HTTP.
</p>

<!-- SSR mode (a): await outside a pending boundary -> resolved data in SSR HTML -->
<ResolvedGreeting name="world" />

<!-- SSR mode (b): await inside a pending boundary -> SSR pending, client fetch resolves -->
<PendingGreeting name="lazily" />

<!-- command + query + refresh: mutate server state and re-fetch, all client-side -->
<RemoteCounter />

<!-- live streaming query -->
<LiveClock />

<!-- custom transport type round-trips into the island via Kit's reused wire codec -->
<TransportProbe />
