<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import IdleLive from '$lib/demos/IdleLive.svelte';
	import IdleFrozen from '$lib/demos/IdleFrozen.svelte';

	let { code }: { code: import('ogygia').RegionValue } = $props();
</script>

<DemoBlock
	title="wake: 'idle'"
	{code}
	onLabel="live"
	offLabel="static"
>
	{#snippet live()}
		<IdleLive />
	{/snippet}
	{#snippet frozen()}
		<IdleFrozen />
	{/snippet}
</DemoBlock>
