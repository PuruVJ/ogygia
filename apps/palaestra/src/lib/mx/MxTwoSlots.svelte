<script lang="ts">
	// An island taking two page-authored snippets, which it hands on to a PLAIN container to render.
	import type { Snippet } from 'svelte';
	import MxPlainContainer from './MxPlainContainer.svelte';
	let { top, middle }: { top?: Snippet; middle?: Snippet } = $props();
	let n = $state(0);
</script>

<section>
	<button data-snip-app-btn onclick={() => (n += 1)}>app {n}</button>
	<MxPlainContainer {top} {middle} />
</section>
