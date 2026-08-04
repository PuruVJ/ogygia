<script>
	import W from '$lib/DedupWidget.svelte' with { hydrate: 'load' };
	import WV from '$lib/DedupWidget.svelte' with { hydrate: 'visible' };
	import RemoteProbe from '$lib/RemoteProbe.svelte' with { hydrate: 'load' };
</script>
<W start={1} /><WV start={2} /><RemoteProbe />
