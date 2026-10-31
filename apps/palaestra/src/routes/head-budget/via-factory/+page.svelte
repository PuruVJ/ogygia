<script lang="ts">
	// HEAD BUDGET behind a helper (e2e/head-budget.spec.ts): the same registry reached through a plain
	// `.ts` module (`factory.ts` → `registry.ts`). The csr=false client leg must give it the same
	// treatment as a direct import: the unrendered marked blocks' CSS stays out, the plain blocks'
	// CSS stays in.
	import type { Component } from 'svelte';
	import { component_for } from '$lib/head-budget/factory';

	const Chosen = component_for('a') as Component<Record<string, unknown>>;
	const Plain = component_for('plain') as Component<Record<string, unknown>>;
</script>

<h1 data-static-shell>head budget — the registry behind a helper module</h1>

<svelte:component this={Chosen} label="chosen block a" />

<Plain />
