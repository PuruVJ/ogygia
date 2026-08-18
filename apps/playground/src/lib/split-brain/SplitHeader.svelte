<script lang="ts">
	// REGRESSION FIXTURE — the production "split brain" (see e2e/split-brain.ts).
	// `$app/stores` is deliberately the FIRST import and a sibling importing the same module
	// comes LATER, and the csr=true /kit page imports this file as a PLAIN component. Under
	// lazy island-graph membership, build order decided which copy of `$app/stores` this file
	// got: reached first through the Kit graph it bundled Kit's REAL client store (never
	// populated under csr=false) while the later siblings got the shim — `$page.url.pathname`
	// threw at hydrate and the header was torn out of the page. With `?og-region` identity the
	// island copy always gets the shim and the /kit copy always gets the real store.
	import { page } from '$app/stores';
	import SplitChild from './SplitChild.svelte';
</script>

<header class="island" data-split-header data-marker="og-e2e-split-brain">
	<span data-split-path>{$page.url.pathname}</span>
	<SplitChild />
</header>
