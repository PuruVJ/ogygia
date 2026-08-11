<script>
	// Passthrough the runtime hydrates a top-level island into, so descendants see the
	// "inside an island" context. Mirrors Region.svelte's island SSR shape EXACTLY
	// (`{#if Component}<Component …>{@render children?.()}</Component>{/if}`) so Svelte adopts the SSR
	// nodes in place instead of discarding and re-creating the island root (a re-created root is
	// class-less for a tick → a `class:`-driven `position: fixed` drops to `static` for a frame).
	import { setNested } from './context.js';

	/** @type {{ component: import('svelte').Component<Record<string, unknown>>, props: Record<string, unknown>, children?: import('svelte').Snippet }} */
	let { component: Component, props, children } = $props();

	setNested();
</script>

{#if Component}<Component {...props}>{@render children?.()}</Component>{/if}
