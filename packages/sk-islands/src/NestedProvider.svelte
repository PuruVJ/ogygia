<script>
	// Passthrough the runtime hydrates a top-level island into, so descendants see the
	// "inside an island" context (client parity with SSR, where the top-level wrapper sets it).
	// Renders nothing of its own — the island component's DOM is unchanged, so hydration matches.
	import { setNested } from './context.js';

	/** @type {{ component: import('svelte').Component<Record<string, unknown>>, props: Record<string, unknown> }} */
	let { component: Component, props } = $props();

	setNested();
</script>

<Component {...props} />
