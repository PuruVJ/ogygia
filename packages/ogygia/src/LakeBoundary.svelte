<script>
	// Wraps a lake's content to RESET the "inside a hydrated island" context to false. A lake makes
	// its subtree dead again (DESIGN.md), so an island authored inside the lake component sees
	// `isNested() === false` during SSR and emits its own `<ogygia-region hydrate>` — it then self-
	// hydrates when the runtime restores the lake's DOM (its region reconnects). Renders nothing of
	// its own, so the lift/restore DOM is unchanged.
	import { setNested } from './context.js';
	let { children } = $props();
	setNested(false);
</script>

{@render children?.()}
