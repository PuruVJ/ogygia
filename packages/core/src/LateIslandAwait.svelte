<script>
	/**
	 * LateIsland.svelte, for an app that runs Svelte's async mode: the build imports this one in its
	 * place (vite/late-island.ts). The load is awaited, so the navigation's update batch waits for it
	 * and Kit keeps the old page until the island's code is in — then swaps the whole new page at once
	 * (an island nested in it awaits in the same batch). Without async mode this file does not compile,
	 * which is why it is never the default.
	 */
	/** @type {{ load: () => Promise<import('svelte').Component>, props: Record<string, unknown>, children?: import('svelte').Snippet }} */
	let { load, props, children } = $props();
	// (a failed load renders nothing)
	const Component = await load().catch(() => undefined);
</script>

{#if Component}<Component {...props}>{@render children?.()}</Component>{/if}
