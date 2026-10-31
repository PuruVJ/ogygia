<script>
	let { start = 0 } = $props();
	// svelte-ignore state_referenced_locally
	let n = $state(start);
	const M = 'standalone-dedup-marker-7b21';
</script>
<button data-dedup title={M} onclick={() => (n += 1)}>dedup {n}</button>
