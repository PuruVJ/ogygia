<script lang="ts">
	// A lake that awaits a query AND hosts an island that can call the same remote (island-in-lake:
	// it wakes on its own). The island's entry names the module → the seed ships for both calls.
	import { getGreeting } from '$lib/greetings.remote';
	import ResolvedGreeting from '$lib/ResolvedGreeting.svelte' with { wake: 'visible' };
	// svelte-ignore state_referenced_locally
	const res = await getGreeting('lake');
</script>

<div class="lake" data-lake-with-reader>
	<p>lake: {res.greeting}</p>
	<ResolvedGreeting name="in-lake" />
</div>
