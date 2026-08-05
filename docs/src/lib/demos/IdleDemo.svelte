<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import IdleLive from '$lib/demos/IdleLive.svelte';
	import IdleFrozen from '$lib/demos/IdleFrozen.svelte';

	const codeHtml = `<span class="tok-keyword">import</span> Widget <span class="tok-keyword">from</span> <span class="tok-string">'$lib/Widget.svelte'</span> <span class="tok-keyword">with</span> {
  hydrate: <span class="tok-string">'idle'</span>
};

<span class="tok-punct">&lt;</span><span class="tok-tag">Widget</span> <span class="tok-punct">/&gt;</span>`;
</script>

<DemoBlock
	title="hydrate: 'idle'"
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
