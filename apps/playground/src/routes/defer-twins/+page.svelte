<script lang="ts">
	// Frame-store dedupe proof: three IDENTICAL server islands. Same component + same props → same
	// minted endpoint → same frame-store address. The runtime must fetch the endpoint ONCE and fan
	// the one response out to all three regions, not fetch three times.
	import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };
</script>

<h1 data-static-shell>Defer twins</h1>
<p data-static-shell>Three identical server islands share one call — expect a single endpoint request.</p>

<Greeting salutation="Twin">
	{#snippet ogygiaFallback()}<p class="fb" data-fallback>loading…</p>{/snippet}
</Greeting>
<Greeting salutation="Twin">
	{#snippet ogygiaFallback()}<p class="fb" data-fallback>loading…</p>{/snippet}
</Greeting>
<Greeting salutation="Twin">
	{#snippet ogygiaFallback()}<p class="fb" data-fallback>loading…</p>{/snippet}
</Greeting>

<style>
	.fb {
		padding: 8px 12px;
		border: 2px dashed #999;
		border-radius: 8px;
		color: #666;
	}
</style>
