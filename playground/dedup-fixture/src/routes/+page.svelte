<script>
	import W from '$lib/DedupWidget.svelte' with { hydrate: 'load' };
	import WV from '$lib/DedupWidget.svelte' with { hydrate: 'visible' };
</script>
<W start={1} /><WV start={2} />
