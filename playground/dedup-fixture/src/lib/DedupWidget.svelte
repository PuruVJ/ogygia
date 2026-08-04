<script>
	let { start = 0 } = $props();
	let n = $state(start);
	const M = 'standalone-dedup-marker-7b21';
</script>
<button data-dedup title={M} onclick={() => (n += 1)}>dedup {n}</button>
