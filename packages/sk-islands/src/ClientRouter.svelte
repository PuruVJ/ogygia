<script>
	/**
	 * Opt-in SPA router (Astro ClientRouter equivalent). Render this in a layout to
	 * enable client-side navigation + view transitions for that section. Without it,
	 * links are plain MPA document loads.
	 * @typedef {Object} Props
	 * @property {boolean} [viewTransitions=true] use the View Transitions API for swaps
	 */
	/** @type {Props} */
	let { viewTransitions = true } = $props();
</script>

<svelte:head>
	<meta name="sk-islands-router" content={viewTransitions ? 'vt' : 'plain'} />
</svelte:head>
