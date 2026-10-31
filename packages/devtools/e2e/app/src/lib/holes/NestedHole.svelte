<script lang="ts">
	// Regression fixture: a `render: 'deferred'` hole whose OWN body carries islands into snippets via
	// RELATIVE specifiers. The hole lives in a subdir (`holes/`) on purpose — every `../x` / `./x` here
	// must resolve against THIS file's directory, never against the snippet entry's virtual id.
	//
	// A snippet that holds a wake island portable-izes into its own entry — a slice of this source
	// re-processed under `virtual:ogygia/island/<iid>.svelte`. That entry has no directory, so a
	// relative marked import inside it used to resolve to `<root>/virtual:ogygia/NestedInner.svelte`
	// and fail the build as an UNRESOLVED_IMPORT out of a region module. Covered permutations:
	//   1. direct placement (never broke — the control);
	//   2. `../` island in a 0-arg snippet at a PLAIN site (the reported shape);
	//   3. `./` sibling island in that same snippet;
	//   4. `../` island in a PARAMETERIZED snippet at a hydrate-ISLAND site (the other branch);
	//   5. a snippet NESTED in a snippet (the entry-within-an-entry hop);
	//   6. a plain relative helper captured into a snippet (resolve_id's own rebase — the control).
	import NestedInner from '../NestedInner.svelte' with { wake: 'load' };
	import NestedSibling from './NestedSibling.svelte' with { wake: 'load' };
	import NestedIslandSite from './NestedIslandSite.svelte' with { wake: 'load' };
	import NestedShell from './NestedShell.svelte';
	import { shout } from './nested-helpers';
	import type { Snippet } from 'svelte';

	// `ogygiaFallback` is the reserved loading slot a deferred hole receives from its call site.
	let { who = 'hole' }: { who?: string; ogygiaFallback?: Snippet } = $props();
</script>

<div data-nested-hole>
	<p data-nested-hole-who>{who}</p>

	<!-- 1. control -->
	<div data-nested-direct><NestedInner label="direct" /></div>

	<!-- 2 + 3 + 6: plain site, 0-arg snippet -->
	<NestedShell>
		{#snippet panel()}
			<div data-nested-in-snippet>
				<NestedInner label="snippet" />
				<NestedSibling label="sibling" />
				<span data-nested-helper>{shout('helper')}</span>
			</div>
		{/snippet}
	</NestedShell>

	<!-- 4: island site, parameterized snippet -->
	<NestedIslandSite>
		{#snippet item(n)}<span data-nested-row={n}><NestedInner label={'row' + n} /></span>{/snippet}
	</NestedIslandSite>

	<!-- 5: snippet nested in a snippet -->
	<NestedShell>
		{#snippet panel()}
			<NestedShell>
				{#snippet panel()}<div data-nested-deep><NestedInner label="deep" /></div>{/snippet}
			</NestedShell>
		{/snippet}
	</NestedShell>
</div>
