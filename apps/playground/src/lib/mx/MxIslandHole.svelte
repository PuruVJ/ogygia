<script lang="ts">
	// A hole whose template places a waking island.
	import Bumper from '../Bumper.svelte' with { wake: 'visible' };
	let { start = 0 }: { start?: number } = $props();
</script>

<div data-mx-hole>hole <Bumper {start} /></div>
