<script lang="ts">
	// A lake (no JS of its own) that holds whatever it is given.
	import type { Snippet } from 'svelte';
	let { children }: { children?: Snippet } = $props();
</script>

<section data-nest="lake">
	<p>static lake text</p>
	{@render children?.()}
</section>
