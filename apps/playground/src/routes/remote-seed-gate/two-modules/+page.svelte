<script lang="ts">
	// Two remote MODULES awaited by the page; the only island imports the second → the seed carries
	// `second` and not `getGreeting`. The gate is per module, not per page.
	import { getGreeting } from '$lib/greetings.remote';
	import { second } from '$lib/remote-seed-gate/second.remote';
	import SecondReader from '$lib/remote-seed-gate/SecondReader.svelte' with { wake: 'load' };
	const g = await getGreeting('page');
	const s = await second('page');
</script>

<h1>two modules</h1>
<p data-two>{g.greeting} / {s.n}</p>
<SecondReader n="island" />
