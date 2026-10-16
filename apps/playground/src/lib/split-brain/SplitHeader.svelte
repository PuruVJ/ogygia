<script lang="ts">
	// REGRESSION FIXTURE — the production "split brain" (see e2e/split-brain.ts).
	// `$app/state` is deliberately the FIRST import and a sibling importing the same module
	// comes LATER, and the csr=true /kit page imports this file as a PLAIN component. Under
	// lazy island-graph membership, build order decided which copy of the page this file got:
	// reached first through the Kit graph it bundled Kit's REAL client page (never populated
	// under csr=false) while the later siblings got the shim — `page.url.pathname` threw at
	// hydrate and the header was torn out of the page. The eager island-graph walk shims this
	// file EVERYWHERE (deterministic); on /kit the kit-world page thread hands the shimmed copy
	// Kit's real `page`, so both worlds read their own truth from ONE module.
	import { page } from '$app/state';
	import SplitChild from './SplitChild.svelte';
	import SharedUrl from './SharedUrl.svelte';
	import SharedData from './SharedData.svelte';
</script>

<header class="island" data-split-header data-marker="og-e2e-split-brain">
	<span data-split-path>{page.url.pathname}</span>
	<SplitChild />
	<SharedUrl />
	<SharedData />
</header>
