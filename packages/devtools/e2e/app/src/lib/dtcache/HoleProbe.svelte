<script lang="ts">
	// A deferred hole (server-only) whose answer carries an ISLAND: the answer's HTML arrives after the
	// page, and the island in it must load the CURRENT build's file too (its `src` rides the answer).
	import type { Snippet } from 'svelte';
	import HoleInner from './HoleInner.svelte' with { wake: 'load' };
	let {}: { ogygiaFallback?: Snippet } = $props();
</script>

<div data-hole-answer="cache"><HoleInner /></div>
