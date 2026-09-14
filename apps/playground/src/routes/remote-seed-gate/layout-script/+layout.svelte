<script lang="ts">
	// A LAYOUT script awaiting a query (the customer's root-layout shape) — gated by the islands of
	// whichever page renders under it.
	import { getGreeting } from '$lib/greetings.remote';
	let { children } = $props();
	const res = await getGreeting('layout');
</script>

<p data-layout-greeting>layout: {res.greeting}</p>
{@render children()}
