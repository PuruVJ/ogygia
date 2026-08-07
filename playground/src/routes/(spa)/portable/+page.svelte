<script lang="ts">
	// Portable island bindings: same import works as a static tag, svelte:component, and list/each.
	import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
	import Greeting from '$lib/Greeting.svelte' with { defer: 'load' };

	const dynamic = Counter;
	const list = [
		{ comp: Counter, props: { start: 1, label: 'list-a' } },
		{ comp: Counter, props: { start: 2, label: 'list-b' } }
	];
</script>

<h1 data-portable-page>Portable island bindings</h1>

<section data-static-use>
	<h2>static tag</h2>
	<Counter start={10} label="static" />
</section>

<section data-dynamic-use>
	<h2>svelte:component</h2>
	<svelte:component this={dynamic} start={20} label="dynamic" />
</section>

<section data-list-use>
	<h2>each list</h2>
	{#each list as item (item.props.label)}
		<svelte:component this={item.comp} {...item.props} />
	{/each}
</section>

<section data-defer-use>
	<h2>defer + fallback</h2>
	<Greeting salutation="Portable">
		{#snippet ogygiaFallback()}
			<p data-portable-fallback>loading greeting…</p>
		{/snippet}
	</Greeting>
</section>
