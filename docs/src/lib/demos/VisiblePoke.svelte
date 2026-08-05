<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import VisibleWidget from '$lib/demos/VisibleWidget.svelte';
	import FrozenVisible from '$lib/demos/FrozenVisible.svelte';

	const codeHtml = `<span class="tok-keyword">import</span> Widget <span class="tok-keyword">from</span> <span class="tok-string">'$lib/Widget.svelte'</span> <span class="tok-keyword">with</span> {
  hydrate: <span class="tok-string">'visible'</span>
};

<span class="tok-punct">&lt;</span><span class="tok-tag">Widget</span> <span class="tok-punct">/&gt;</span>`;
</script>

<DemoBlock title="poke · visible" {codeHtml} onLabel="hydrated · visible">
	{#snippet live()}
		<VisibleWidget />
	{/snippet}
	{#snippet frozen()}
		<FrozenVisible />
	{/snippet}
</DemoBlock>
