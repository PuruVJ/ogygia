<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import VisibleLive from '$lib/demos/VisibleLive.svelte';
	import VisibleFrozen from '$lib/demos/VisibleFrozen.svelte';

	let { code }: { code: import('ogygia').RegionValue } = $props();
</script>

<DemoBlock
	title="wake: 'visible'"
	{code}
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
