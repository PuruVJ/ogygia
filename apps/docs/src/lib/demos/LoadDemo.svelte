<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import LoadLive from '$lib/demos/LoadLive.svelte';
	import LoadFrozen from '$lib/demos/LoadFrozen.svelte';

	let { codeHtml }: { codeHtml: string } = $props();
</script>

<DemoBlock
	title="wake: 'load'"
	{codeHtml}
	onLabel="live"
	offLabel="static"
>
	{#snippet live()}
		<LoadLive />
	{/snippet}
	{#snippet frozen()}
		<LoadFrozen />
	{/snippet}
</DemoBlock>
