<script lang="ts">
	// A server island (render: deferred) that deliberately takes `s` SECONDS to render on the server.
	// Used to PROVE out-of-order streaming: in the batch stream each region's <template> is flushed the
	// moment that region settles, so a fast region declared LATER lands BEFORE a slow one declared earlier.
	let { s = 0, label = '' }: { s?: number; label?: string; ogygiaFallback?: unknown } = $props();
	await new Promise((r) => setTimeout(r, s * 1000));
	const at = new Date().toISOString();
</script>

<div data-slow-greeting data-s={s}>
	<strong>{label}</strong> — settled after {s}s, rendered at {at}
</div>
