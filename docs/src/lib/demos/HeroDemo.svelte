<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import LoadLive from '$lib/demos/LoadLive.svelte';
	import LoadFrozen from '$lib/demos/LoadFrozen.svelte';

	const codeHtml = `<span class="tok-keyword">import</span> Counter <span class="tok-keyword">from</span> <span class="tok-string">'$lib/Counter.svelte'</span> <span class="tok-keyword">with</span> {
  hydrate: <span class="tok-string">'load'</span>
};

<span class="tok-punct">&lt;</span><span class="tok-tag">Counter</span> <span class="tok-punct">/&gt;</span>`;
</script>

<DemoBlock title="load" {codeHtml} stack onLabel="live" offLabel="static">
	{#snippet live()}
		<LoadLive />
	{/snippet}
	{#snippet frozen()}
		<LoadFrozen />
	{/snippet}
</DemoBlock>
