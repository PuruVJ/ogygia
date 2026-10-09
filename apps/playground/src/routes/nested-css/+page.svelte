<script lang="ts">
	// NESTED ISLAND CSS (e2e/nested-css.spec.ts): an island inside an island loads its component
	// lazily, so the outer island's chunk closure (static edges only) never carries the inner one's
	// sheet. The inner island must link its own CSS from the render, before the outer island wakes —
	// both when the outer imports it directly and when it finds it in a registry at render time.
	import Outer from '$lib/nested-css/Outer.svelte' with { wake: 'interaction' };
</script>

<h1 data-static-shell>nested island css — the outer island stays asleep</h1>

<Outer />
