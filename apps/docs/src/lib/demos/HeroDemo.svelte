<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import LoadLive from '$lib/demos/LoadLive.svelte';
	import LoadFrozen from '$lib/demos/LoadFrozen.svelte';

	let { code }: { code: string } = $props();
</script>

<DemoBlock title="load" {code} stack onLabel="live" offLabel="static">
	{#snippet live()}
		<LoadLive />
	{/snippet}
	{#snippet frozen()}
		<LoadFrozen />
	{/snippet}
</DemoBlock>
