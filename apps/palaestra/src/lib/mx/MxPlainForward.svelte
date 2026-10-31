<script lang="ts">
	// A PLAIN component: renders `blocks` in place AND forwards it into an island.
	import SnipApp from '../SnipApp.svelte' with { wake: 'load' };
	import type { Snippet } from 'svelte';
	let { blocks }: { blocks?: Snippet } = $props();
</script>

<div data-in-place>{@render blocks?.()}</div>
<div data-forwarded><SnipApp {blocks} /></div>
