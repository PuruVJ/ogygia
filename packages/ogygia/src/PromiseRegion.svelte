<script>
	/**
	 * A `<Region of={promise}>` (Region.svelte hands the promise here): the region owns the whole wait.
	 * This one works anywhere — the server cannot wait without Svelte's async mode, so it renders the
	 * placeholder and the browser resolves the promise after hydration (where the app runs async mode,
	 * PromiseRegionAwait.svelte awaits it in the render instead: vite/late-island.ts).
	 *
	 * LATE SLOT: inside a document that delivers late chunks (the server router's streamed document
	 * opens that scope), the placeholder is wrapped in an `og-late-slot` the response fills when the
	 * promise settles. Nowhere else: a slot nothing fills stays empty forever.
	 *
	 * LAG, don't clear: a NEW promise (a re-search) keeps the previous value on screen until it lands,
	 * so the old content morphs instead of flashing through empty.
	 */
	import Region from './Region.svelte';
	import { register_late_region } from './late-region-registry.js';

	/** @type {{ of: Promise<import('./region.js').RegionValue>, placeholder?: import('svelte').Snippet, children?: import('svelte').Snippet }} */
	let { of, placeholder, children } = $props();

	// svelte-ignore state_referenced_locally
	const late_slot = typeof window === 'undefined' ? register_late_region(of) : null;
	/** @type {import('./region.js').RegionValue | undefined} */
	let awaited = $state(undefined);
	$effect(() => {
		const p = of;
		let live = true;
		Promise.resolve(p).then((r) => {
			if (live) awaited = r;
		});
		return () => {
			live = false;
		};
	});
</script>

{#if awaited}<Region of={awaited} {placeholder} {children} />{:else if late_slot}<og-late-slot data-og-slot={late_slot} style="display:contents"
		>{@render placeholder?.()}</og-late-slot
	>{:else}{@render placeholder?.()}{/if}
