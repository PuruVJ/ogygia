<script lang="ts">
	// Context under the SPA router. Reached by client-side navigation (fetch + body swap). The new
	// page's provider markup + serialized payload arrive in the swapped body, and the islands
	// re-hydrate, so get() must resolve exactly as on a fresh load.
	import { Context } from 'ogygia';
	import CtxWriter from '$lib/CtxWriter.svelte' with { wake: 'load' };
	import CtxReader from '$lib/CtxReader.svelte' with { wake: 'load' };
	import { SharedCounter } from '$lib/counter-object.svelte.js';
	import { roomCtx } from '$lib/room-context.svelte.js';

	const counter = new SharedCounter('nav', 3);
</script>

<h1 data-static-shell>Context after SPA nav</h1>

<Context of={roomCtx} value={counter}>
	<CtxWriter />
	<CtxReader label="nav" />
</Context>

<style>
	:global(ogygia-region) {
		display: block;
		margin: 6px 0;
	}
</style>
