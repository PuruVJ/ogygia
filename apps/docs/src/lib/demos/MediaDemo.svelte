<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import MediaLive from '$lib/demos/MediaLive.svelte';
	import MediaFrozen from '$lib/demos/MediaFrozen.svelte';

	let { code }: { code: import('ogygia').RegionValue } = $props();
</script>

<DemoBlock
	title="wake: media"
	{code}
	onLabel="live"
	offLabel="static"
>
	{#snippet live()}
		<MediaLive />
	{/snippet}
	{#snippet frozen()}
		<MediaFrozen />
	{/snippet}
</DemoBlock>
