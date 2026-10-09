<script lang="ts">
	import BigHeader from '$lib/BigHeader.svelte' with { render: 'deferred', stitch: 'serve' };
	let { data } = $props();
</script>

<BigHeader>
	{#snippet ogygiaFallback()}
		<p data-stitch-fallback>loading…</p>
	{/snippet}
</BigHeader>

<h1 data-freeze-page>stitched</h1>
<p>This SHELL is a stored freeze: render <span data-render>{data.render}</span> never moves.</p>
<p>
	The header above was rendered on the server FOR YOU and spliced into the stored bytes —
	check view-source: your name is in the first response.
</p>
<p>
	<a href="/api/user?name=Puru">log in as Puru</a> · <a href="/api/user">log out</a>
</p>
