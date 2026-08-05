<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import VisibleLive from '$lib/demos/VisibleLive.svelte';
	import VisibleFrozen from '$lib/demos/VisibleFrozen.svelte';

	const codeHtml = `<span class="tok-keyword">import</span> Chart <span class="tok-keyword">from</span> <span class="tok-string">'$lib/Chart.svelte'</span> <span class="tok-keyword">with</span> {
  hydrate: <span class="tok-string">'visible'</span>
};

<span class="tok-punct">&lt;</span><span class="tok-tag">Chart</span> <span class="tok-punct">/&gt;</span>`;
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
