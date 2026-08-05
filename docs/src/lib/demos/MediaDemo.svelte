<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import MediaLive from '$lib/demos/MediaLive.svelte';
	import MediaFrozen from '$lib/demos/MediaFrozen.svelte';

	const codeHtml = `<span class="tok-keyword">import</span> Drawer <span class="tok-keyword">from</span> <span class="tok-string">'$lib/Drawer.svelte'</span> <span class="tok-keyword">with</span> {
  hydrate: <span class="tok-string">'(max-width: 600px)'</span>
};

<span class="tok-punct">&lt;</span><span class="tok-tag">Drawer</span> <span class="tok-punct">/&gt;</span>`;
</script>

<DemoBlock
	title="hydrate: '(max-width: 600px)'"
	{codeHtml}
	onLabel="live"
	offLabel="static"
>
	{#snippet live()}
		<MediaLive />
	{/snippet}
	{#snippet frozen()}
		<MediaFrozen />
	{/snippet}
</DemoBlock>
