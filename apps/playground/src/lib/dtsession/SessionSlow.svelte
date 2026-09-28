<script lang="ts">
	// PLANTED slow-interaction: the click handler works 250 ms before the screen can update.
	let n = $state(0);
	function spin_on_click() {
		const until = performance.now() + 250;
		while (performance.now() < until);
		n++;
	}
</script>

<button data-ds="slow" onclick={spin_on_click}>slow {n}</button>
