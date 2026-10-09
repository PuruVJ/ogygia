<script>
	// A shared layout island (identical props across both delta routes) with a SERVER render marker.
	// On an SPA nav between the routes, the server should SKIP re-rendering this (its fp is unchanged)
	// — proven by data-og-skipped in the delta response — while the client keeps it live + interactive.
	const renderedAt =
		typeof performance !== 'undefined' ? Math.floor(performance.now() * 1000) % 1000000 : 0;
	let clicks = $state(0);
</script>

<nav class="island" data-delta-nav>
	<span data-delta-stamp>nav-server-stamp:{renderedAt}</span>
	<button data-delta-btn onclick={() => (clicks += 1)}>clicks <span data-delta-clicks>{clicks}</span></button>
	<a href="/delta/a" data-to-a>A</a>
	<a href="/delta/b" data-to-b>B</a>
</nav>
