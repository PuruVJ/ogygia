<script lang="ts">
	import HeaderHost from '$lib/HeaderHost.svelte' with { wake: 'load' };
	let { data } = $props();
</script>

<HeaderHost />

<h1 data-artifact-page>live-header</h1>
<p>This SHELL is a stored artifact: render <span data-render>{data.render}</span> never moves.</p>
<p>
	The header above arrived server-rendered IN the stored bytes (no fallback flash), then
	re-rendered itself on the server with YOUR cookies and swapped in.
</p>
<p>
	<a href="/api/user?name=Puru">log in as Puru</a> · <a href="/api/user">log out</a>
</p>
