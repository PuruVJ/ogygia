<script lang="ts">
	// A region host whose OWN template places a lake (with a waking island inside it).
	import SnipLake from '../SnipLake.svelte' with { wake: 'none' };
	let { start = 0 }: { start?: number } = $props();
</script>

<div data-mx-host>host <SnipLake {start} /></div>
