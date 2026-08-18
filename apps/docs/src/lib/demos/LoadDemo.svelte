<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import LoadLive from '$lib/demos/LoadLive.svelte';
	import LoadFrozen from '$lib/demos/LoadFrozen.svelte';

	let { code }: { code: import('ogygia').RegionValue } = $props();
</script>

<DemoBlock
	title="wake: 'load'"
	{code}
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
