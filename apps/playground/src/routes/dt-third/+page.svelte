<script lang="ts">
	// The THIRD-PARTY answer key page (internal/bench/devtools-answer-key.mjs --third): planted other
	// origins — a render-blocking script that edits an island, a tag-manager-shaped script that burns
	// main-thread time and adds three scripts — next to a decoy (a tiny async script) and a healthy
	// island. The Page tab and the profiler report must name the planted ones, never the decoy.
	import ThirdTarget from '$lib/dtlab/ThirdTarget.svelte' with { wake: 'load' };
	import Healthy from '$lib/dtlab/Healthy.svelte' with { wake: 'load' };
	let { data } = $props();
</script>

<svelte:head>
	<script src="{data.third}/blocking.js" crossorigin="anonymous"></script>
	<script async src="{data.third}/tag.js" crossorigin="anonymous"></script>
	<script async src="{data.third}/tiny.js" crossorigin="anonymous"></script>
</svelte:head>

<h1>third-party lab</h1>
<ThirdTarget />
<Healthy />
