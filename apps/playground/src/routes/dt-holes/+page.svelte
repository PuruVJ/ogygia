<script lang="ts">
	// HOLES for the devtools answer key: a deferred hole whose server render throws (its answer
	// never comes: the fallback stays) next to a healthy one (the decoy). The auth-wall cookie on
	// /hole-wall plants the other failure, a refused answer.
	import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };
	import BrokenHole from '$lib/dtholes/BrokenHole.svelte' with { render: 'deferred' };
	import SlowHole from '$lib/dtholes/SlowHole.svelte' with { render: 'deferred' };
</script>

<h1>holes lab</h1>
<Greeting salutation="Hello">
	{#snippet ogygiaFallback()}<p data-hole="greeting">loading greeting…</p>{/snippet}
</Greeting>
<SlowHole label="planted">
	{#snippet ogygiaFallback()}<p data-hole="slow">loading the slow hole…</p>{/snippet}
</SlowHole>
<BrokenHole label="planted">
	{#snippet ogygiaFallback()}<p data-hole="broken">loading the broken hole…</p>{/snippet}
</BrokenHole>
