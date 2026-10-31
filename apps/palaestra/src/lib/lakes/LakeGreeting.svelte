<script lang="ts">
	// A LAKE that awaits a remote query for its own server render. Nothing about it runs in the
	// browser, so its result must not be seeded into the page (REMOTE SEED ONLY WHEN REACHABLE) —
	// unless some island on the same page can call the same remote (e2e/remote-seed-gate.spec.ts).
	import { getGreeting } from '$lib/greetings.remote';
	// svelte-ignore state_referenced_locally
	const res = await getGreeting('lake');
</script>

<div class="lake" data-lake-greeting>
	<strong>Lake, resolved on the server:</strong>
	{res.greeting} — computed {res.at.toISOString()}
</div>
