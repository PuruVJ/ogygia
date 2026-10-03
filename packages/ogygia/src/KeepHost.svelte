<script lang="ts">
	// Keep-alive host for a KEPT island (`keep:`): LiveHost's props-pushable host — the "inside an
	// island" context, `$state` props, `setProps` so the next page's props reach the relocated island —
	// in the SSR shape of a placed island (Region.svelte's `{#if Component}<Component {...props} />{/if}`,
	// as NestedProvider mirrors it). LiveHost has no `{#if}`: it hydrates a live region's render()
	// output, and a kept island hydrated through it met the server's `[0` branch marker where it
	// expected the component's own, discarding the server DOM on every load. NOT part of the public API.
	import { setNested } from './context.js';
	import type { Component as SvelteComponent } from 'svelte';

	let {
		component: Component,
		initialProps
	}: { component: SvelteComponent<Record<string, unknown>>; initialProps: Record<string, unknown> } = $props();

	// Seed once from the incoming prop; later pages replace it via setProps(). Intentional initial read.
	// svelte-ignore state_referenced_locally
	let current = $state(initialProps);

	/** Called by the runtime when the island crosses to the next page — reactive prop push. */
	export function setProps(next: Record<string, unknown>) {
		current = next;
	}

	setNested();
</script>

{#if Component}<Component {...current} />{/if}
