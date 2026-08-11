<script lang="ts">
	// Batch frame stream target: three DISTINCT server islands (different props → different signed
	// calls → different frame-store addresses). verify/frame-batch.ts harvests their endpoints and
	// POSTs them to the batch endpoint, expecting one response with three out-of-order frames.
	import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };
</script>

<h1 data-static-shell>Frame batch</h1>

<Greeting salutation="Alpha">
	{#snippet ogygiaFallback()}<p data-fallback>loading a…</p>{/snippet}
</Greeting>
<Greeting salutation="Beta">
	{#snippet ogygiaFallback()}<p data-fallback>loading b…</p>{/snippet}
</Greeting>
<Greeting salutation="Gamma">
	{#snippet ogygiaFallback()}<p data-fallback>loading c…</p>{/snippet}
</Greeting>
