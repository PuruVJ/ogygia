<script>
	// Stands in for Kit's own page render root: Kit sets its `__request__` context with `{ page }`
	// and NO `event` (ogygia's render roots add the event themselves) — the fact Region.svelte
	// reads to know it renders inside Kit's page pass.
	import { setContext } from 'svelte';
	import { KIT_REQUEST_CONTEXT } from '../../src/server/kit-context.js';
	let { children } = $props();
	setContext(KIT_REQUEST_CONTEXT, { page: {} });
</script>

{@render children?.()}
