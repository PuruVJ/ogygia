<script lang="ts">
	// Receives a transportable (SharedCounter) as a PROP, used as a server island (defer) and as a
	// deferred client island (defer+hydrate). Proves ServerIsland.svelte encodes the wire codec on
	// BOTH its paths: the signed endpoint payload and the props-sibling script.
	import type { SharedCounter } from './counter-object.svelte.js';

	let { counter, label = 'srv' }: { counter: SharedCounter; label?: string } = $props();
</script>

<div class="island" data-transport-srv={label} data-is-instance={typeof counter?.inc === 'function'}>
	count = <strong data-ts-count>{counter?.count ?? -1}</strong>
</div>
