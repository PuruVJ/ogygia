<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import Counter from '$lib/demos/Counter.svelte';
	import FrozenCounter from '$lib/demos/FrozenCounter.svelte';

	const codeHtml = `<span class="tok-keyword">import</span> Counter <span class="tok-keyword">from</span> <span class="tok-string">'$lib/Counter.svelte'</span> <span class="tok-keyword">with</span> {
  hydrate: <span class="tok-string">'load'</span>
};

<span class="tok-punct">&lt;</span><span class="tok-tag">Counter</span> <span class="tok-attr">start</span>=<span class="tok-punct">{</span><span class="tok-number">7</span><span class="tok-punct">}</span> <span class="tok-punct">/&gt;</span>`;
</script>

<DemoBlock title="poke · Counter.svelte" {codeHtml} onLabel="hydrated">
	{#snippet live()}
		<Counter start={7} label="Poke counter" note="Toggle JS in the header" />
	{/snippet}
	{#snippet frozen()}
		<FrozenCounter start={7} note="Static HTML, no listeners" />
	{/snippet}
</DemoBlock>
