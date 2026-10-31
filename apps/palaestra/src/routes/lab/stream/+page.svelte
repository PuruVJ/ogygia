<script lang="ts">
	// Deferred SERVER islands: the component renders on the server on demand and streams in. Its
	// `ogygiaFallback` snippet shows in the initial HTML; NO component JS ships to the browser.
	import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };
</script>

<h1>Streaming server islands</h1>
<p>
	Each purple box below is a <b>deferred server island</b>. The initial HTML carries only the dashed
	fallback; the runtime then fetches the server-rendered component from <code>/_islands</code> and
	swaps it in. Watch the Network tab for the <code>/_islands</code> request(s).
</p>

<h2>Island one</h2>
<Greeting salutation="Hello">
	{#snippet ogygiaFallback()}
		<p class="fallback" data-lab-fallback>loading greeting one…</p>
	{/snippet}
</Greeting>

<h2>Island two (independent hole)</h2>
<Greeting salutation="Streamed">
	{#snippet ogygiaFallback()}
		<p class="fallback" data-lab-fallback>loading greeting two…</p>
	{/snippet}
</Greeting>

<style>
	.fallback {
		padding: 12px 16px;
		border: 2px dashed #999;
		border-radius: 8px;
		color: #666;
		max-width: 420px;
	}
	h2 {
		font-size: 1rem;
		margin-top: 18px;
	}
</style>
