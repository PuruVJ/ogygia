<script>
	/**
	 * AN INLINE ISLAND A CLIENT NAVIGATION CREATED — Kit made its wrapper in the browser, with no
	 * rendered stamp, so its component was not loaded yet. Load it, and render it when it lands: the
	 * navigation shows an empty place first, then the island. A client render, nothing to mismatch.
	 *
	 * Where the app runs Svelte's async mode, the build imports LateIslandAwait.svelte in this one's
	 * place, which holds the navigation until the code is in (vite/late-island.ts).
	 */
	/** @type {{ load: () => Promise<import('svelte').Component>, props: Record<string, unknown>, children?: import('svelte').Snippet }} */
	let { load, props, children } = $props();
	/** @type {import('svelte').Component | undefined} */
	let Component = $state(undefined);
	// (a failed load renders nothing)
	// svelte-ignore state_referenced_locally
	load().then(
		(c) => (Component = c),
		() => {}
	);
</script>

{#if Component}<Component {...props}>{@render children?.()}</Component>{/if}
