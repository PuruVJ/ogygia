<script lang="ts">
	// Keep-alive host for an INTERACTIVE live region (`query.live` yielding `region(C, props)`
	// with a wake schedule). Like NestedProvider, it sets the "inside an island" context and renders
	// the component with no DOM of its own (so it hydrates the server render() output cleanly). Unlike
	// NestedProvider, its props are `$state` and it exposes `setProps` — so a live tick updates the
	// MOUNTED component reactively instead of tearing it down and re-hydrating. Focus and local island
	// state survive; Svelte reconciles the view. NOT part of the public API.
	import { setNested } from './context.js';
	import type { Component as SvelteComponent } from 'svelte';

	let {
		component: Component,
		initialProps
	}: { component: SvelteComponent<Record<string, unknown>>; initialProps: Record<string, unknown> } = $props();

	// Seed once from the incoming prop; later ticks replace it via setProps(). Intentional initial read.
	// svelte-ignore state_referenced_locally
	let current = $state(initialProps);

	/** Called by the runtime on each live tick with the same component — reactive prop push. */
	export function setProps(next: Record<string, unknown>) {
		current = next;
	}

	setNested();
</script>

<Component {...current} />
