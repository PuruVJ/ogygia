<script lang="ts">
	// Writer island — revives the SAME live transportable from context (wire id 'setctx-room') and
	// mutates it. Proves the drop-in setContext bridged a LIVE instance, not a snapshot: bumping here
	// repaints every reader that shares it.
	import { getContext } from 'svelte';
	import type { SharedCounter } from '$lib/counter-object.svelte.js';

	const room = getContext<SharedCounter | undefined>('room');
</script>

<button class="island" data-setctx-writer onclick={() => room?.inc()}>bump ({room?.count ?? -1})</button>
