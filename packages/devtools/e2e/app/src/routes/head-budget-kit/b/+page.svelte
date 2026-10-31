<script lang="ts">
	import type { Component } from 'svelte';
	import { block } from '$lib/head-budget/registry';

	const Chosen = block('b') as Component<Record<string, unknown>>;
</script>

<h1 data-static-shell>head budget (csr=true) — block b</h1>

<nav><a href="/head-budget-kit" data-to-a>back to block a (client navigation)</a></nav>

<svelte:component this={Chosen} label="chosen block b" />
