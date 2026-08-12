<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import VisibleWidget from '$lib/demos/VisibleWidget.svelte';
	import FrozenVisible from '$lib/demos/FrozenVisible.svelte';

	let { codeHtml }: { codeHtml: string } = $props();
</script>

<DemoBlock title="poke · visible" {codeHtml} onLabel="hydrated · visible">
	{#snippet live()}
		<VisibleWidget />
	{/snippet}
	{#snippet frozen()}
		<FrozenVisible />
	{/snippet}
</DemoBlock>
