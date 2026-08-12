<script lang="ts">
	// A separate island bundle. Reads the live counter from context, no prop. `label` only names the
	// DOM node so a page with several readers can be queried apart — the value still comes from get().
	import { roomCtx } from '$lib/room-context.svelte.js';

	let { label = 'reader' }: { label?: string } = $props();
	const counter = roomCtx.get();
</script>

<span class="island" data-ctx-reader={label} data-is-instance={counter ? 'true' : 'false'}>
	<span data-ctx-count>{counter?.count ?? -1}</span>
	<span data-ctx-double>{counter?.double ?? -1}</span>
</span>
