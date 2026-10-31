<script lang="ts">
	// Islands INSIDE a `{#snippet}` handed to a PLAIN component that renders it same-graph
	// (`{@render demo()}`), on a csr=false page. Regression for two compiler/runtime bugs:
	//  1. the portable-snippet synth used to emit CLEANED imports, silently demoting an island
	//     placed in the snippet body to a plain component (no region, no JS);
	//  2. the live snippet's server leg rendered through the SYNC `ssr_render`, so a top-level
	//     `await` inside the snippet body threw `await_invalid` (the docs-home 500).
	// ResolvedGreeting top-level-awaits a remote; Bumper is the interactivity probe.
	import SnippetCard from '$lib/SnippetCard.svelte';
	import ResolvedGreeting from '$lib/ResolvedGreeting.svelte' with { wake: 'load' };
	import Bumper from '$lib/Bumper.svelte' with { wake: 'load' };

	const label = 'in-snippet';
</script>

<nav><a href="/">Home</a></nav>
<h1 data-static>Islands inside a snippet to a plain shell</h1>

<SnippetCard title="demo card">
	{#snippet demo()}
		<ResolvedGreeting name={label} />
		<Bumper start={3} />
	{/snippet}
</SnippetCard>
