<script>
	/**
	 * PromiseRegion.svelte, for an app that runs Svelte's async mode: the build imports this one in its
	 * place (vite/late-island.ts). The promise is AWAITED IN THE RENDER: the server render waits for it
	 * (Kit seeds a remote query's result into the page), hydration awaits the same value, and the page
	 * arrives with the region in it — no placeholder flash, no client fetch. The value renders in its
	 * WIRE form on both sides (`wire_form`: what crossed, as the browser has it), baked: its first HTML
	 * is in the page, and every later value (a refresh) morphs in.
	 *
	 * Inside a document that delivers late chunks (the server router's streamed document), the late
	 * slot still wins: the document streams instead of waiting. Without async mode this file does not
	 * compile, which is why it is never the default.
	 */
	import Region from './Region.svelte';
	import { register_late_region } from './late-region-registry.js';
	import { wire_form } from './transport.js';

	/** @type {{ of: Promise<import('./region.js').RegionValue>, placeholder?: import('svelte').Snippet, children?: import('svelte').Snippet }} */
	let { of, placeholder, children } = $props();

	// svelte-ignore state_referenced_locally
	const late_slot = typeof window === 'undefined' ? register_late_region(of) : null;
</script>

{#if late_slot}<og-late-slot data-og-slot={late_slot} style="display:contents"
		>{@render placeholder?.()}</og-late-slot
	>{:else}<Region of={wire_form(await of)} {placeholder} {children} __baked />{/if}
