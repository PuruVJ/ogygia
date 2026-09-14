<script lang="ts">
	// The PAGE's own script awaits a query (csr=false: this script never runs in the browser) next to
	// an island that calls none → no seed.
	import { getGreeting } from '$lib/greetings.remote';
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	const res = await getGreeting('page');
</script>

<h1>page script</h1>
<p data-page-greeting>page: {res.greeting}</p>
<Counter label="no remote here" />
