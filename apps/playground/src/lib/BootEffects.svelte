<script lang="ts">
	// HEADLESS boot island. Renders nothing visible — it just runs the browser-only side effects that a
	// csr=false layout's script can no longer run. This is the minimal-change shape: the layout keeps
	// its template + setContext, and ONLY the side-effect statements move here. Mirrors x.svelte's
	// setStores / onMount / beforeNavigate.
	import { onMount } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { bootStore } from '$lib/boot-store.svelte.js';

	let { data } = $props();

	onMount(() => {
		bootStore.ready = true; // shared-store write (setStores analog)
		bootStore.pageViews += 1; // analytics stub
		document.body.classList.add('boot-ran'); // body class
		document.body.dataset.bootApp = data?.appName ?? ''; // proves `data` crossed into the island
		(window as unknown as { __bootPageViews?: number }).__bootPageViews =
			((window as unknown as { __bootPageViews?: number }).__bootPageViews ?? 0) + 1;
	});

	beforeNavigate(() => {
		bootStore.navGuardHits += 1; // nav guard side effect
	});
</script>

<span data-boot-effects hidden></span>
