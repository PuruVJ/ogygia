<script>
	// Wraps a frozen region's content to RESET the "inside an awake region" context to false. A
	// `hydrate="none"` boundary makes its subtree dead again (DESIGN.md), so a waking region authored
	// inside it sees `isNested() === false` during SSR and emits its own `<ogygia-region hydrate>` —
	// it then self-runs when the runtime restores the frozen DOM (its region reconnects). Renders
	// nothing of its own, so the lift/restore DOM is unchanged.
	import { setNested } from './context.js';
	let { children } = $props();
	setNested(false);
</script>

{@render children?.()}
