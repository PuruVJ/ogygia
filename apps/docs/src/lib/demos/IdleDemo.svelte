<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import IdleLive from '$lib/demos/IdleLive.svelte';
	import IdleFrozen from '$lib/demos/IdleFrozen.svelte';

	let { codeHtml }: { codeHtml: string } = $props();
</script>

<DemoBlock
	title="wake: 'idle'"
	{codeHtml}
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
