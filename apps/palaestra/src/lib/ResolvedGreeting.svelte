<script lang="ts">
	import { getGreeting } from '$lib/greetings.remote';
	let { name } = $props();
	// await OUTSIDE any pending boundary -> fully resolved during SSR.
	// svelte-ignore state_referenced_locally
	const res = await getGreeting(name);
</script>

<div class="island" data-resolved-greeting>
	<strong>Resolved at SSR:</strong>
	{res.greeting} — computed {res.at.toISOString()}
</div>
