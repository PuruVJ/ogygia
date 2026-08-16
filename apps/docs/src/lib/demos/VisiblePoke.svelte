<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import VisibleWidget from '$lib/demos/VisibleWidget.svelte';
	import FrozenVisible from '$lib/demos/FrozenVisible.svelte';

	let { code }: { code: import('ogygia').RegionValue } = $props();
</script>

<DemoBlock title="poke · visible" {code} onLabel="hydrated · visible">
	{#snippet live()}
		<VisibleWidget />
	{/snippet}
	{#snippet frozen()}
		<FrozenVisible />
	{/snippet}
</DemoBlock>
