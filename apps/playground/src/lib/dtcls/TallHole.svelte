<script lang="ts">
	import type { Snippet } from 'svelte';
	// PLANTED: a hole whose answer is far taller than its fallback — when it swaps in, everything
	// below it moves down. The devtools must say the hole's answer made the page shift.
	let {}: { ogygiaFallback?: Snippet } = $props();
	await new Promise((ok) => setTimeout(ok, 400));
</script>

<div data-cls-hole style="height: 420px; background: #eef">the hole's answer, tall</div>
