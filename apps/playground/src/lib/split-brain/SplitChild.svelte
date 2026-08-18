<script lang="ts">
	// Level 2 of the region graph, and deliberately the RUNES api (`$app/state`, a different shim
	// file than the parent's `$app/stores`): both must resolve to ogygia's shims in the region
	// world. Under the old lazy membership this "lucky sibling" usually joined the graph in time
	// and got the shim while its parent kept Kit's real (empty) store — the split brain. Now both
	// agree because the mark rides in the id.
	import { page } from '$app/state';
	import SplitGrandchild from './SplitGrandchild.svelte';
</script>

<span data-split-child-path>{page.url.pathname}</span>
<SplitGrandchild />
