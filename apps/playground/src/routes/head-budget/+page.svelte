<script lang="ts">
	// HEAD BUDGET (e2e/head-budget.spec.ts): what a csr=false page links must be decided by what it
	// RENDERS, never by what its module graph reaches. Three shapes on one page:
	//   - a `.ts` registry of six marked blocks (Builder-style), ONE placed by reference;
	//   - a marked import placed directly;
	//   - a marked import that is imported but never placed.
	// Only the two rendered islands may cost a stylesheet + a chunk hint.
	import type { Component } from 'svelte';
	import { block } from '$lib/head-budget/registry';
	import BlockDirect from '$lib/head-budget/BlockDirect.svelte' with { wake: 'load' };
	import BlockUnused from '$lib/head-budget/BlockUnused.svelte' with { wake: 'load' };

	const Chosen = block('a') as Component<Record<string, unknown>>;
	// referenced so the import is not tree-shaken as unused by the linter; never placed
	void BlockUnused;
</script>

<h1 data-static-shell>head budget — one registry block of six, one direct island, one unused mark</h1>

<svelte:component this={Chosen} label="chosen block a" />

<BlockDirect />
