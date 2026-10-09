<script lang="ts">
	/**
	 * The nested-context RESET around an island's in-place slot children. Region `setNested()`s for its
	 * subtree so islands rendered INSIDE an island degrade to plain inline components — but slot children
	 * belong to the HOST page, not the island: an island inside them must render as a FULL region
	 * (`<ogygia-region>` + payload) so the runtime can wake it independently after the parent ADOPTS the
	 * slot DOM. Server-only in practice (the client adopts, never re-renders slot children).
	 */
	import { setNested } from './context.js';
	import type { Snippet } from 'svelte';

	let { children }: { children?: Snippet } = $props();

	setNested(false);
</script>

{@render children?.()}
