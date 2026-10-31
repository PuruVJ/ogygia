<script lang="ts">
	// A hole fetched on load (its `wake`), whose template places a lake (with a waking island inside it).
	import SnipLake from '../SnipLake.svelte' with { wake: 'none' };
	let { start = 0 }: { start?: number } = $props();
</script>

<div data-mx-hole>hole <SnipLake {start} /></div>
