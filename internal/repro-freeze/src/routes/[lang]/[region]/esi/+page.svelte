<script lang="ts">
	import BigHeader from '$lib/BigHeader.svelte' with { render: 'deferred', stitch: 'edge' };
	let { data } = $props();
</script>

<BigHeader>
	{#snippet ogygiaFallback()}
		<p data-stitch-fallback>loading…</p>
	{/snippet}
</BigHeader>

<h1 data-freeze-page>esi</h1>
<p>This SHELL is a stored freeze: render <span data-render>{data.render}</span> never moves.</p>
<p>
	The header above is an EDGE-stitched hole: the stored bytes carry an ESI include the CDN fills
	per request from the hole's signed capability, so the shell stays cached at the edge and origin
	renders only the header.
</p>
<p>
	<a href="/api/user?name=Puru">log in as Puru</a> · <a href="/api/user">log out</a>
</p>
