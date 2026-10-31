<script lang="ts">
	// A region host whose OWN template places a hole (with a waking island inside the hole).
	import MxIslandHole from './MxIslandHole.svelte' with { render: 'deferred' };
	let { start = 0 }: { start?: number } = $props();
</script>

<div data-mx-host>host <MxIslandHole {start} /></div>
