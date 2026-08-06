<script lang="ts">
	import type { Snippet } from 'svelte';

	let { salutation = 'Aloha', ogygiaFallback }: { salutation?: string; ogygiaFallback?: Snippet } = $props();

	// Deferred server render: stamped at island-fetch time, not page SSR.
	const at = new Date().toLocaleTimeString();
	const name = 'voyager';
</script>

<div class="widget widget--greeting" data-server-greeting>
	<strong>{salutation}, {name}</strong>
	<p class="widget-meta">Rendered on the server at {at}</p>
</div>
