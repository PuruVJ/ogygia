<script lang="ts">
	// The STYLES answer key page (internal/bench/devtools-answer-key.mjs --styles): two planted
	// problems. leak.css carries the build's unscoped-fallback marker for LabCard.svelte (the shape
	// ogygia writes when it cannot compile a component's scoped CSS), and its `.row` rule restyles
	// markup it was never meant for. unused.css is 600 rules that match nothing here. The healthy
	// island's scoped styles are the decoy: devtools and the profiler must name the planted two only.
	import Healthy from '$lib/dtlab/Healthy.svelte' with { wake: 'load' };
</script>

<svelte:head>
	<link rel="stylesheet" href="/dt-styles/leak.css" />
	<link rel="stylesheet" href="/dt-styles/unused.css" />
</svelte:head>

<h1>styles lab</h1>
<p class="row">This paragraph never asked for a yellow background: an unscoped <code>.row</code> gave it one.</p>
<Healthy />
