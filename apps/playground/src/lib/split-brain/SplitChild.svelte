<script lang="ts">
	// Level 2 of the region graph: it must resolve to ogygia's shim in the region world, as its
	// parent does. Under the old lazy membership this "lucky sibling" usually joined the graph in
	// time and got the shim while its parent kept Kit's real (empty) page — the split brain. Now
	// both agree because the mark rides in the id.
	import { page } from '$app/state';
	import SplitGrandchild from './SplitGrandchild.svelte';
</script>

<span data-split-child-path>{page.url.pathname}</span>
<SplitGrandchild />
