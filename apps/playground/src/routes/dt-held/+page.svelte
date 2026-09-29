<script lang="ts">
	// HELD FOR A FAILING ISLAND, for the devtools answer key: a first-screen island whose module is
	// slow and then throws, and a ready island below the fold that waits for it. The wait is the
	// scheduler's viewport-first hold, explained by the failing island's load: `held-idle` (ogygia's
	// own unexplained wait) must stay quiet; `hydrate-failed` names SlowFail.
	import SlowFail from '$lib/dtheld/SlowFail.svelte' with { wake: 'load' };
	import BelowReady from '$lib/dtheld/BelowReady.svelte' with { wake: 'load' };
</script>

<h1>held lab</h1>
<SlowFail />
<div style="height: 2400px">spacer</div>
<BelowReady />
