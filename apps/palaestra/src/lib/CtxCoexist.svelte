<script lang="ts">
	// Context and transportable PROPS coexist. This island receives the same SharedCounter BOTH as a
	// prop AND via context. Because both paths run through the wire-id memo, they must resolve to the
	// exact same live instance (===), proving the two mechanisms reunite rather than fork.
	import { roomCtx } from '$lib/room-context.svelte.js';
	import type { SharedCounter } from '$lib/counter-object.svelte.js';

	let { counter: propCounter }: { counter: SharedCounter } = $props();
	const ctxCounter = roomCtx.get();
</script>

<span
	class="island"
	data-ctx-coexist
	data-same={propCounter === ctxCounter ? 'true' : 'false'}
	data-is-instance={ctxCounter ? 'true' : 'false'}
>
	<span data-coexist-prop>{propCounter?.count ?? -1}</span>
	<span data-coexist-ctx>{ctxCounter?.count ?? -1}</span>
</span>
