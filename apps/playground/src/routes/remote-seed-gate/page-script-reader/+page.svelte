<script lang="ts">
	// The page script awaits a query AND an island on the page can call that remote → the seed
	// ships, the page's call included (same module).
	import { getGreeting } from '$lib/greetings.remote';
	import ResolvedGreeting from '$lib/ResolvedGreeting.svelte' with { wake: 'load' };
	const res = await getGreeting('page');
</script>

<h1>page script + reader</h1>
<p data-page-greeting>page: {res.greeting}</p>
<ResolvedGreeting name="reader" />
