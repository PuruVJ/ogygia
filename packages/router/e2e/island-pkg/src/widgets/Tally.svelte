<script>
	let { start = 0 } = $props();
	// svelte-ignore state_referenced_locally
	let n = $state(start);
</script>

<button data-pkg-island onclick={() => n++}>pkg tally: {n}</button>
