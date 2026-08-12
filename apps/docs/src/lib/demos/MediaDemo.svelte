<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import MediaLive from '$lib/demos/MediaLive.svelte';
	import MediaFrozen from '$lib/demos/MediaFrozen.svelte';

	let { codeHtml }: { codeHtml: string } = $props();
</script>

<DemoBlock
	title="wake: media"
	{codeHtml}
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
