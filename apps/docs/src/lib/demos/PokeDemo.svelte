<script lang="ts">
	import DemoBlock from '$lib/DemoBlock.svelte';
	import Counter from '$lib/demos/Counter.svelte';
	import FrozenCounter from '$lib/demos/FrozenCounter.svelte';

	let { codeHtml }: { codeHtml: string } = $props();
</script>

<DemoBlock title="poke · Counter.svelte" {codeHtml} onLabel="hydrated">
	{#snippet live()}
		<Counter start={7} label="Poke counter" note="Toggle JS in the header" />
	{/snippet}
	{#snippet frozen()}
		<FrozenCounter start={7} note="Static HTML, no listeners" />
	{/snippet}
</DemoBlock>
