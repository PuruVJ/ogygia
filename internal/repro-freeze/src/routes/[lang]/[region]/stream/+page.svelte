<script lang="ts">
	import Tick from '$lib/Tick.svelte' with { wake: 'load' };
	let { data } = $props();
</script>

<h1 data-freeze-page>stream</h1>
<p>render <span data-render>{data.render}</span></p>
{#await data.slow}
	<p data-slow>waiting…</p>
{:then value}
	<p data-slow>{value}</p>
{/await}
<Tick />
