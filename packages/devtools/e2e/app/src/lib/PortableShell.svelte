<script lang="ts">
	// A PLAIN (non-island) shell. It renders `actions` same-graph AND forwards it into an island
	// (PortableBar). The page hands `actions` as a normal snippet; the compiler makes it portable so
	// the island copy can cross the boundary and hydrate.
	import PortableBar from './PortableBar.svelte' with { wake: 'load' };
	import type { Snippet } from 'svelte';
	let { actions, children }: { actions?: Snippet; children?: Snippet } = $props();
</script>

<header data-shell-header>head:{#if actions}{@render actions()}{/if}</header>
<main data-shell-main>{@render children?.()}</main>
<PortableBar {actions} />
