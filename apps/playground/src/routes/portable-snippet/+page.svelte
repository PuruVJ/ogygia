<script lang="ts">
	// Portable snippets: the page hands `actions` to a PLAIN shell, which forwards it into an island.
	// The snippet captures a host value (who) and contains a NESTED island (Bumper). It must render on
	// SSR in BOTH the same-graph header and the crossed-into-island bar, survive hydration, and the
	// nested island inside the crossed copy must come alive (5 → 6 on click).
	import PortableShell from '$lib/PortableShell.svelte';
	import Bumper from '$lib/Bumper.svelte' with { wake: 'load' };

	const who = 'Ada';
</script>

<nav><a href="/">Home</a></nav>
<h1 data-static>Portable snippets</h1>

<PortableShell>
	{#snippet actions()}
		<a data-gh href="#gh">GitHub · {who}</a>
		<Bumper start={5} />
	{/snippet}
	<p data-body>body for {who}</p>
</PortableShell>
