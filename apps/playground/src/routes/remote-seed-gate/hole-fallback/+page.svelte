<script lang="ts">
	// A deferred hole whose fallback holds a lake awaiting the query (page pass) and whose own render
	// awaits it on the endpoint. The only island calls nothing → no seed on the page.
	import GateHole from '$lib/remote-seed-gate/GateHole.svelte' with { render: 'deferred' };
	import LakeGreeting from '$lib/lakes/LakeGreeting.svelte' with { wake: 'none' };
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
</script>

<h1>hole + fallback lake</h1>
<GateHole>
	{#snippet ogygiaFallback()}
		<LakeGreeting />
	{/snippet}
</GateHole>
<Counter label="no remote here" />
