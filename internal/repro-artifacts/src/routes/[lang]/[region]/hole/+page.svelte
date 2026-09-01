<script lang="ts">
	import Hole from '$lib/Hole.svelte' with { render: 'deferred' };
	let { data } = $props();
</script>

<h1 data-artifact-page>hole</h1>
<p>render <span data-render>{data.render}</span></p>
<Hole>
	{#snippet ogygiaFallback()}
		<p data-hole-fallback>loading…</p>
	{/snippet}
</Hole>
