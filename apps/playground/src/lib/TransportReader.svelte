<script lang="ts">
	// Island B: receives the SAME transportable instance as a prop, only reads. Uses ONLY
	// `import type` — proving the transportables manifest registers Cart's codec on the client
	// without this island importing the class as a value. If liveness works, clicks in
	// TransportWriter repaint this island.
	import type { SharedCounter } from './counter-object.svelte.js';

	let { counter }: { counter: SharedCounter } = $props();
</script>

<div class="island" data-transport-reader data-is-instance={typeof counter?.inc === 'function'}>
	count = <strong data-t-count>{counter.count}</strong>, double = <span data-t-double>{counter.double}</span>
</div>
