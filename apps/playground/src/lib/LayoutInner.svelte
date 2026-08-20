<script lang="ts">
	// The WHOLE layout body, moved into one component and rendered as a load island by the shell. Its
	// script runs on the server (SSR) AND on the client when the island wakes — which is what makes the
	// side effects run again in the browser on a csr=false page. Mirrors x.svelte: a computed template
	// var, a cross-island setContext, onMount work, a nav guard, a shared-store write, a body class.
	import { onMount } from 'svelte';
	import { setContext } from 'ogygia';
	import { beforeNavigate } from '$app/navigation';
	import { bootStore } from '$lib/boot-store.svelte.js';

	let { data, children } = $props();

	// A template var computed in the script (like currentDir / isPreferenceCenter in x.svelte).
	const currentDir = data?.rtl ? 'rtl' : 'ltr';

	// Drop-in setContext → records on the server, page marker seeds child islands.
	setContext('currentDir', currentDir);

	let mounted = $state(false);

	// SIDE EFFECTS — the whole reason the script must run in the browser.
	onMount(() => {
		mounted = true;
		bootStore.ready = true; // shared-store write
		bootStore.pageViews += 1; // analytics stub
		document.body.classList.add('boot-ran'); // body class
		(window as unknown as { __bootPageViews?: number }).__bootPageViews =
			((window as unknown as { __bootPageViews?: number }).__bootPageViews ?? 0) + 1;
	});

	beforeNavigate(() => {
		bootStore.navGuardHits += 1; // nav guard side effect
	});
</script>

<div data-layout-inner data-dir={currentDir} data-mounted={mounted} data-boot-ready={bootStore.ready}>
	<header data-chrome>Header · dir={currentDir} · app={data?.appName}</header>
	{@render children?.()}
	<footer data-chrome>Footer</footer>
</div>
