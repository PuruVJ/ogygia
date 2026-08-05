<script lang="ts">
	// Reuses the docs DemoBlock + visible live/frozen pair, but the code shown is a NAMED PRESET.
	// On the /playground/strategies page this component is imported `with { preset: 'demo' }`, which
	// resolves to `{ hydrate: 'visible', margin: '200px' }` from the docs vite config.
	import DemoBlock from '$lib/DemoBlock.svelte';
	import VisibleLive from '$lib/demos/VisibleLive.svelte';
	import VisibleFrozen from '$lib/demos/VisibleFrozen.svelte';

	const codeHtml = `<span class="tok-comment">// vite.config.ts</span>
ogygia({
  presets: {
    demo: { hydrate: <span class="tok-string">'visible'</span>, margin: <span class="tok-string">'200px'</span> }
  }
});

<span class="tok-comment">// component</span>
<span class="tok-keyword">import</span> Panel <span class="tok-keyword">from</span> <span class="tok-string">'$lib/Panel.svelte'</span> <span class="tok-keyword">with</span> {
  preset: <span class="tok-string">'demo'</span>
};`;
</script>

<DemoBlock title="preset: 'demo'" {codeHtml} stack onLabel="live" offLabel="static">
	{#snippet live()}
		<VisibleLive />
	{/snippet}
	{#snippet frozen()}
		<VisibleFrozen />
	{/snippet}
</DemoBlock>
