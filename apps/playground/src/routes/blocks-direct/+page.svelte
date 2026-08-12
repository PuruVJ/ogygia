<script lang="ts">
	// No content collection — a tree in hand, rendered through the MyBlocks recipe.
	import MyBlocks from '$lib/MyBlocks.svelte';
	import { tree, registry } from '$lib/blocks-direct-registry';
</script>

<h1 data-static-shell>Direct blocks (recipe, no collection)</h1>
<MyBlocks {tree} {registry} />
