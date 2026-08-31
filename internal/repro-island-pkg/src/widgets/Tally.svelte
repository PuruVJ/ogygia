<script>
	let { start = 0 } = $props();
	let n = $state(start);
</script>

<button data-pkg-island onclick={() => n++}>pkg tally: {n}</button>
