<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import VisibleLive from '$lib/demos/VisibleLive.svelte';
	import VisibleFrozen from '$lib/demos/VisibleFrozen.svelte';

	let { codeHtml }: { codeHtml: string } = $props();
</script>

<DemoBlock
	title="hydrate: 'visible'"
	{codeHtml}
	onLabel="live"
	offLabel="static"
>
	{#snippet live()}
		<VisibleLive />
	{/snippet}
	{#snippet frozen()}
		<VisibleFrozen />
	{/snippet}
</DemoBlock>
