<script lang="ts">
	// PLANTED hydration-shift: a banner appears one frame after waking and pushes the island's own
	// content down (the moved nodes sit inside the island, so the shift is traced to it).
	import { onMount } from 'svelte';
	let open = $state(false);
	onMount(() => {
		requestAnimationFrame(() => (open = true));
	});
</script>

<div data-dt="grower">
	{#if open}<div style="height: 220px; background: #eef2ff">a banner that appears after waking</div>{/if}
	<p style="margin: 0; padding: 20px 0; font-size: 22px">content that gets pushed down when the banner appears</p>
</div>
