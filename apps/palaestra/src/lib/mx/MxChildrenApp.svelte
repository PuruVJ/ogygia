<script lang="ts">
	// An island that renders page-authored children (slot children: adopted, not hydrated).
	import type { Snippet } from 'svelte';
	let { children }: { children?: Snippet } = $props();
	let n = $state(0);
</script>

<section data-mx-children-app>
	<button data-snip-app-btn onclick={() => (n += 1)}>app {n}</button>
	{@render children?.()}
</section>
