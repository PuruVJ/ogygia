<script lang="ts">
	// Context reaches an island buried inside a FROZEN lake. The provider is on the page; the lake
	// (wake: 'none') is inside a hydrated host; the reader is authored inside the lake and
	// self-hydrates. Its get() must walk up through the frozen lake DOM to the page provider.
	import { Provide } from 'ogygia';
	import CtxLakeHost from '$lib/CtxLakeHost.svelte' with { wake: 'load' };
	import { SharedCounter } from '$lib/counter-object.svelte.js';
	import { roomCtx } from '$lib/room-context.svelte.js';

	const counter = new SharedCounter('lake', 7);
</script>

<nav><a href="/">Home</a> <a href="/context">Matrix</a></nav>
<hr />
<h1 data-static-shell>Context into a lake</h1>

<Provide values={[ roomCtx(counter) ]}>
	<CtxLakeHost />
</Provide>
