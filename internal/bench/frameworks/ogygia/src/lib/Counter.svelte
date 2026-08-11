<script>
	import { untrack } from 'svelte';

	/** Canonical bench widget — identical DOM across every framework. */
	let { start = 0 } = $props();
	let n = $state(untrack(() => start));
</script>

<button class="bench-counter" onclick={() => n++}>count: {n}</button>
