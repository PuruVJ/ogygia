<script lang="ts">
	// An island awaiting the same PRERENDER remote at SSR — the async-island FOUC case the `p`
	// seed exists for: with the seed, hydration resolves synchronously and never re-fetches.
	import { getManifesto } from '$lib/greetings.remote';
	// svelte-ignore state_referenced_locally
	const m = await getManifesto();
</script>

<div class="island" data-manifesto-reader>manifesto (island): {m.text}</div>
