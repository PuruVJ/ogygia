<script lang="ts">
	// Single authoring syntax: the import attribute. Every usage of a marked import
	// becomes an island with the given strategy.
	import Counter from '$lib/Counter.svelte' with { hydrate: 'load' };
	// per-use strategy: import the SAME module again with a different strategy
	import CounterLazy from '$lib/Counter.svelte' with { hydrate: 'visible' };
	import Visible from '$lib/Visible.svelte' with { hydrate: 'visible' };
	import MediaBox from '$lib/MediaBox.svelte' with { hydrate: '(max-width: 600px)' };
	import DevalueProps from '$lib/DevalueProps.svelte' with { hydrate: 'load' };
	import SnippetChildren from '$lib/SnippetChildren.svelte' with { hydrate: 'load' };
	import EachItem from '$lib/EachItem.svelte' with { hydrate: 'load' };

	// Static (server-only) data — captured into islands as devalue-serialized props.
	const title = 'Snippet island';
	const y = 42;
	const date = new Date('2024-01-02T03:04:05.678Z');
	const map = new Map([
		['a', 1],
		['b', 2],
	]);
	const set = new Set([1, 2, 3]);
	const big = 9007199254740993n;
	const nested = { deep: { value: 'nested-ok', when: new Date('2020-05-05T00:00:00.000Z') } };
	const items = [
		{ name: 'Alpha', score: 1 },
		{ name: 'Bravo', score: 2 },
		{ name: 'Charlie', score: 3 },
	];
</script>

<h1 data-static-shell>ogygia playground</h1>
<p data-static-shell>
	This shell text is server-rendered and never hydrated. The page ships zero Kit JS (<code
		>csr = false</code
	>). Only the islands below hydrate.
</p>

<!-- load strategy -->
<Counter start={10} label="Import-attribute counter" />

<!-- devalue-serialized complex props -->
<DevalueProps {date} {map} {set} {big} {nested} />

<!-- snippet children + regular children using outer-scope vars -->
<SnippetChildren {title}>
	{#snippet header()}
		<em>header snippet sees outer var y = {y}</em>
	{/snippet}
	<span>children content, y doubled = {y * 2}</span>
</SnippetChildren>

<!-- island inside {#each} — each-local captured as a prop -->
{#each items as item, index}
	<EachItem {item} {index} />
{/each}

<!-- media strategy -->
<MediaBox query="(max-width: 600px)" />

<div class="spacer">scroll down to hydrate the visible islands…</div>

<!-- visible strategy -->
<Visible note="(import attribute, visible)" />

<!-- per-use strategy: same Counter module, visible instead of load -->
<CounterLazy start={99} label="Same module, visible strategy" />
