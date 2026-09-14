<script lang="ts">
	// The footer's shape: a lake that awaits a query and hosts an island that calls NO remote
	// (a form island, say). Nothing on the client can call the remote → no seed.
	import { getGreeting } from '$lib/greetings.remote';
	import Counter from '$lib/Counter.svelte' with { wake: 'visible' };
	// svelte-ignore state_referenced_locally
	const res = await getGreeting('lake');
</script>

<div class="lake" data-lake-with-silent>
	<p>lake: {res.greeting}</p>
	<Counter label="silent island in the lake" />
</div>
