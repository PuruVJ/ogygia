<script lang="ts">
	// The complex SERVER-RENDERED header. Marked `render: 'live'` at the import site:
	// its HTML is baked into the page (first bytes, no fallback), and on load it revalidates
	// in the background — a fresh SERVER render with the visitor's cookies, swapped in.
	import type { Snippet } from 'svelte';
	import { whoami } from '$lib/session.remote';
	// the deferred call sites pass the reserved fallback (shown until the hole answers)
	let { ogygiaFallback }: { ogygiaFallback?: Snippet } = $props();

	const session = await whoami();
</script>

<header data-big-header style="border: 2px solid #333; padding: 8px">
	<strong data-hello>Hello, {session.user ?? 'guest'}</strong>
	<small data-rendered-at>server-rendered at {session.at}</small>
</header>
