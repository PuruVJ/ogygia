<script>
	// Wraps a frozen region's content to RESET the "inside an awake region" context to false. A
	// `hydrate="none"` boundary makes its subtree dead again (DESIGN.md), so a waking region authored
	// inside it sees `isNested() === false` during SSR and emits its own `<ogygia-region hydrate>` —
	// it then self-runs when the runtime restores the frozen DOM (its region reconnects). Renders
	// nothing of its own, so the lift/restore DOM is unchanged.
	// It also MARKS the subtree as a lake's inside: on a Kit-hydrated (csr=true) document the lake is
	// adopted as opaque DOM, so a waking region inside it must still emit its real `<ogygia-region>`
	// (Region reads `isInLake()` to skip its csr=true inline degradation there).
	import { setNested, setInLake } from './context.js';
	let { children } = $props();
	setNested(false);
	setInLake();
</script>

{@render children?.()}
