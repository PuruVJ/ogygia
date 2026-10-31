<script lang="ts">
	// Portable island bindings: same import works as a static tag, dynamic <Comp />, and list/each.
	import Counter from '$lib/Counter.svelte' with { wake: 'load' };
	import Greeting from '$lib/Greeting.svelte' with { render: 'deferred' };

	const Dynamic = Counter;
	const list = [
		{ Comp: Counter, props: { start: 1, label: 'list-a' } },
		{ Comp: Counter, props: { start: 2, label: 'list-b' } }
	];
</script>

<h1 data-portable-page>Portable island bindings</h1>

<section data-static-use>
	<h2>static tag</h2>
	<Counter start={10} label="static" />
</section>

<section data-dynamic-use>
	<h2>dynamic component</h2>
	<Dynamic start={20} label="dynamic" />
</section>

<section data-list-use>
	<h2>each list</h2>
	{#each list as { Comp, props } (props.label)}
		<Comp {...props} />
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
