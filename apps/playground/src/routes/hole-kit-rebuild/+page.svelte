<script lang="ts">
	// A csr=true page whose hydration FAILS on purpose (Boom throws once in the browser): Svelte
	// logs "Failed to hydrate", Kit mounts the document fresh, and every deferred hole on it is
	// rendered again by the client leg — which cannot mint an address. The runtime remembered each
	// hole's server-minted facts under its identity (`data-og-hole`) at parse time and hands them
	// back, so the holes still fetch (and a hydrating hole still gets its props).
	// The holes live in a shared component (RebuildChrome): a route host's own marks are stripped
	// on a csr=true page, a component's are not — the customer's header shape.
	// e2e/hole-kit-rebuild.spec.ts.
	import Boom from '$lib/Boom.svelte';
	import RebuildChrome from '$lib/RebuildChrome.svelte';
	let n = $state(0);
</script>

<h1 data-page>csr=true page that Kit rebuilds in the browser (holes must still fill)</h1>
<Boom />
<button data-kit-btn onclick={() => n++}>kit:{n}</button>
<RebuildChrome />
