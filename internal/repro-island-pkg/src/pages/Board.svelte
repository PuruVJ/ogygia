<script>
	let { data } = $props();
	let hits = $state(0);
</script>

<section data-pkg-board>
	<h1>{data.title}</h1>
	<button data-pkg-board-btn onclick={() => hits++}>board hits: {hits}</button>
</section>
