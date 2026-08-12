<script>
	let { children } = $props();
</script>

<svelte:head>
	<link rel="stylesheet" href="/post.css" />
	<title>ogygiaBench — sveltekit</title>
</svelte:head>

{@render children()}
