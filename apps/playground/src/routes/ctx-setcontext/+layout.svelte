<script lang="ts">
	// Drop-in setContext: the ONLY change from a normal Svelte layout is the import source
	// (`svelte` → `ogygia`). This csr=false layout's context reaches child islands (separate
	// hydration roots) with no <Provide> in the template — the handle emits one page-level marker
	// each island seeds its own getContext() from. Mirrors a real company +layout.svelte.
	import { setContext } from 'ogygia';
	import { writable } from 'svelte/store';
	import { SharedCounter } from '$lib/counter-object.svelte.js';

	let { children } = $props();

	// A plain object, a plain string, and a LIVE transportable — all bridge through setContext.
	setContext('boot', { theme: 'midnight', user: 'ada' });
	setContext('appName', 'playground');
	setContext('room', new SharedCounter('setctx-room', 8));

	// NON-serializable values a real layout sets (x.svelte does both): a function and a live store.
	// These can't bridge to islands, but the drop-in setContext must NOT crash the page — they are
	// silently dropped from the marker while the serializable keys above still cross.
	setContext('trackPageView', () => {});
	setContext('appStore', writable({ count: 0 }));
</script>

{@render children()}
