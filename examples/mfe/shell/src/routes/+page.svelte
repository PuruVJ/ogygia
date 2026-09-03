<script lang="ts">
	import ShellNav from '$lib/ShellNav.svelte' with { wake: 'load' };
	import { Region } from 'ogygia';
	import type { RegionValue } from 'ogygia';
	// The regions arrived from the SERVER load, across Kit's wire (transport codec in src/hooks.ts).
	let { data }: { data: { kpis: RegionValue; live: RegionValue } } = $props();
</script>

<svelte:head>
	<!-- the opening cart, printed by the SERVER — any language can print this tag -->
	{@html '<script type="application/json" data-og-shared="corp.cart">' +
		JSON.stringify({ items: ['seeded-item'] }) +
		'</scr' +
		'ipt>'}
</svelte:head>

<main>
	<ShellNav />
	<h1>Shell home</h1>
	<p>Everything below the line came from the dash team's server at render time:</p>
	<hr />
	<h2>Static (baked into this page, freezable):</h2>
	<div data-testid="static-dash"><Region of={data.kpis} /></div>
	<h2>Deferred (a per-visitor hole through the shell):</h2>
	<div data-testid="deferred-dash">
		<Region of={data.live}>
			{#snippet placeholder()}<p data-testid="deferred-loading">loading…</p>{/snippet}
		</Region>
	</div>
</main>

<style>
	main {
		max-width: 640px;
		margin: 2rem auto;
		font-family: system-ui, sans-serif;
	}
</style>
