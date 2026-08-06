<script>
	/**
	 * Optional public annotation wrapper around a region usage.
	 *
	 * Renders {@linkcode children} only — no extra DOM, no nested-island context, and no
	 * `hydrate` / `render` attributes. Use it when you want to mark an island in source for
	 * humans (or a future hook). It is **not** `<svelte:boundary>` and **not** the internal
	 * lake context reset (`LakeBoundary`).
	 *
	 * @component
	 * @typedef {Object} Props
	 * @property {import('svelte').Snippet} [children] Content to render unchanged.
	 */
	/** @type {Props} */
	let { children } = $props();
</script>

{@render children?.()}
