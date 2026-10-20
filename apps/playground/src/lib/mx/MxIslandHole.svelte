<script lang="ts">
	// A hole whose template places a waking island.
	import type { Snippet } from 'svelte';
	import Bumper from '../Bumper.svelte' with { wake: 'visible' };
	// `ogygiaFallback` is the reserved loading slot a deferred hole receives from its call site.
	let { start = 0 }: { start?: number; ogygiaFallback?: Snippet } = $props();
</script>

<div data-mx-hole>hole <Bumper {start} /></div>
