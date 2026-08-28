<script lang="ts">
	import ShellNav from '$lib/ShellNav.svelte' with { wake: 'load' };
	import FragmentHole from '$lib/FragmentHole.svelte' with { wake: 'load' };
	let { data } = $props();
</script>

<svelte:head>
	<!-- the opening cart, printed by the SERVER — any language can print this tag -->
	{@html '<script type="application/json" data-og-shared="corp.cart">' + JSON.stringify({ items: ['seeded-item'] }) + '</scr' + 'ipt>'}
</svelte:head>

<main>
	<ShellNav />
	<h1>Shell home</h1>
	<p>Everything below the line came from another server at render time:</p>
	<hr />
	<!-- eslint-disable-next-line svelte/no-at-html-tags — trusted federation: dash is our team -->
	{@html data.kpis.html}
	<h2>Lazy client-stitched (through the shell proxy):</h2>
	<FragmentHole app="dash" name="kpis" props={{ org: 'lazy-inc' }} />
</main>

<style>
	main {
		max-width: 640px;
		margin: 2rem auto;
		font-family: system-ui, sans-serif;
	}
</style>
