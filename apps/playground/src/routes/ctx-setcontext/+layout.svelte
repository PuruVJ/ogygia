<script lang="ts">
	// Drop-in setContext: the ONLY change from a normal Svelte layout is the import source
	// (`svelte` → `ogygia`). This csr=false layout's context reaches child islands (separate
	// hydration roots) with no <Provide> in the template — the handle emits one page-level marker
	// each island seeds its own getContext() from. Mirrors a real company +layout.svelte.
	import { setContext } from 'ogygia';
	import { SharedCounter } from '$lib/counter-object.svelte.js';

	let { children } = $props();

	// A plain object, a plain string, and a LIVE transportable — all bridge through setContext.
	setContext('boot', { theme: 'midnight', user: 'ada' });
	setContext('appName', 'playground');
	setContext('room', new SharedCounter('setctx-room', 8));
</script>

{@render children()}
