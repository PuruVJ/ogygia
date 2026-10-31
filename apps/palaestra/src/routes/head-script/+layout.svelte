<script lang="ts">
	import DynIsland from '$lib/DynIsland.svelte' with { wake: 'load' };
	let { children } = $props();
	const someHtml = '<span data-html>x</span>';
</script>

<svelte:head>
	<script defer type="text/javascript" src="https://example.com/w.js"></script>
	<link rel="stylesheet" href="https://example.com/w.css" />
	{@html someHtml}
</svelte:head>

{@html '<!-- seindexable begin -->'}
<div data-probe><DynIsland /></div>
{@render children()}
{@html '<!-- seindexable end -->'}
