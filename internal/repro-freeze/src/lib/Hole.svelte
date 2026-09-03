<script lang="ts">
	import type { Snippet } from 'svelte';
	import { next_hole_serial } from '$lib/hole-serial.js';

	// Server island (render: 'deferred') — renders on its own signed endpoint per request.
	// `ogygiaFallback` is the reserved loading slot (hand-declared — the law).
	let { ogygiaFallback }: { ogygiaFallback?: Snippet } = $props();
	const serial = next_hole_serial();
</script>

<p data-hole-serial>{serial}</p>
