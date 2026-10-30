<script lang="ts">
	// An island that calls a page-authored snippet WITH an argument, once per row.
	import type { Snippet } from 'svelte';
	let { row }: { row?: Snippet<[number]> } = $props();
	let n = $state(0);
</script>

<section>
	<button data-snip-app-btn onclick={() => (n += 1)}>app {n}</button>
	{#each [1, 2] as i (i)}{@render row?.(i)}{/each}
</section>
