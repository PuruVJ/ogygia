<script lang="ts">
	import type { Snippet } from 'svelte';
	import { whoAmI } from '$lib/playground/whoami.remote';

	// A reserved `fallback` snippet is declared so svelte-check accepts it at the call site; the
	// transform strips it before this component renders.
	let { fallback }: { fallback?: Snippet } = $props();

	// Awaited outside a pending boundary: fully resolved during the deferred server render on the
	// island endpoint (not during page SSR). Reads the visitor's cookie there.
	const data = await whoAmI();
</script>

<div class="widget widget--greeting" data-cookie-greeting>
	<strong>Welcome back, {data.name}</strong>
	<p class="widget-meta">read from your cookie on the server · {data.at}</p>
</div>
