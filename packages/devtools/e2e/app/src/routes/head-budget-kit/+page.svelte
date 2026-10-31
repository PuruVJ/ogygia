<script lang="ts">
	// HEAD BUDGET on a csr=true page (e2e/head-budget-kit.spec.ts): a six-block registry with ONE
	// block placed by reference, plus a directly placed mark, on a route Kit hydrates. The
	// regression this guards: a csr=true route importing a block registry linked every block's
	// stylesheet and chunk (a newsroom page: 172 stylesheets for 4 islands), because each mark's
	// client wrapper reached its component statically. Now the client wrapper's component is lazy:
	// what the document RENDERED (stamped per island) is imported before Kit hydrates; nothing else
	// ships. (A mark authored ON a csr=true route host is stripped to a plain import — ogygia steps
	// aside there — so BlockDirect below is Kit's own component: linked, hydrated, no stamp.)
	import type { Component } from 'svelte';
	import { block } from '$lib/head-budget/registry';
	import BlockDirect from '$lib/head-budget/BlockDirect.svelte' with { wake: 'load' };

	const Chosen = block('a') as Component<Record<string, unknown>>;
</script>

<h1 data-static-shell>head budget (csr=true) — one registry block of six, one direct mark</h1>

<nav><a href="/head-budget-kit/b" data-to-b>to block b (client navigation)</a></nav>

<svelte:component this={Chosen} label="chosen block a" />

<BlockDirect />
