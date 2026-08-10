<script lang="ts">
	// Plain-value context: `themeCtx` holds a string with a default of 'light'. A reader under a
	// provider sees the provided value (a snapshot, not a live object); a reader with no provider
	// above it falls back to the default.
	import { themeCtx } from '$lib/room-context.svelte.js';

	let { label = 'theme' }: { label?: string } = $props();
	const theme = themeCtx.get();
</script>

<span class="island" data-ctx-theme={label}>{theme}</span>
