<script lang="ts">
	// A layout island composed from the OUTSIDE: default children, a named `header` snippet, and a
	// parameterized `row` snippet the island calls with its own data. All authored by the page.
	import type { Snippet } from 'svelte';
	let {
		title,
		children,
		header,
		row
	}: {
		title: string;
		children?: Snippet;
		header?: Snippet;
		row?: Snippet<[string]>;
	} = $props();
	let open = $state(true);
	const items = ['one', 'two'];
</script>

<section class="island" data-card-shell>
	<button data-card-toggle onclick={() => (open = !open)}>{title} ({open ? 'open' : 'shut'})</button>
	{@render header?.()}
	{#if open}
		<div data-card-body>{@render children?.()}</div>
		<ul data-card-rows>
			{#each items as it (it)}{@render row?.(it)}{/each}
		</ul>
	{/if}
</section>
