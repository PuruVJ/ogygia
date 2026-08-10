<script>
	import W from '$lib/DedupWidget.svelte' with { wake: 'load' };
	import WV from '$lib/DedupWidget.svelte' with { wake: 'visible' };
	import RemoteProbe from '$lib/RemoteProbe.svelte' with { wake: 'load' };
</script>
<W start={1} /><WV start={2} /><RemoteProbe />
