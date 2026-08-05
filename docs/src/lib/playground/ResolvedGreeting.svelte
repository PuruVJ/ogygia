<script lang="ts">
	import { getGreeting } from '$lib/playground/data.remote';

	let { name = 'world' }: { name?: string } = $props();

	// Awaited OUTSIDE any pending boundary, so it fully resolves during SSR. In a production build
	// the result is seeded into the client cache, so hydration adopts the on-screen HTML without a
	// re-fetch (under `vite dev` the seed can't cross module isolation, so dev re-fetches — cosmetic).
	// svelte-ignore state_referenced_locally
	const res = await getGreeting(name);
</script>

<div class="widget widget--greeting" data-resolved-greeting>
	<strong>{res.greeting}</strong>
	<p class="widget-meta">resolved during SSR · stamped {res.at.toISOString()}</p>
</div>
