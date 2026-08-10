<script lang="ts">
	// `orphanCtx` is never provided anywhere. get() must return the default, never crash, even with
	// no <ogygia-context> above this island in the DOM.
	import { orphanCtx } from '$lib/room-context.svelte.js';

	const v = orphanCtx.get();
</script>

<span class="island" data-ctx-orphan>{v}</span>
