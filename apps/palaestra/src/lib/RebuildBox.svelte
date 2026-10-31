<script lang="ts">
	// A deferred hole whose HTML carries a `wake: 'load'` island — the "personalized AND
	// interactive" shape (server island with a nested wake island). On hole-kit-rebuild the hole
	// must still fetch after Kit rebuilt the page, and the island inside its answer must wake.
	import type { Snippet } from 'svelte';
	import Counter from './Counter.svelte' with { wake: 'load' };
	let { start = 0, ogygiaFallback }: { start?: number; ogygiaFallback?: Snippet } = $props();
</script>

<div data-rebuild-box>
	<Counter {start} label="in-hole" />
</div>
