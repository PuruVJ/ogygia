<script lang="ts">
	// Static furniture (placed as a lake) with a waking island authored inside it.
	import Bumper from './Bumper.svelte' with { wake: 'visible' };
	let { start = 0 }: { start?: number } = $props();
</script>

<div data-snip-lake>lake <Bumper {start} /></div>
