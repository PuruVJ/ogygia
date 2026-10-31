<script lang="ts">
	// /dt-jank's plant: on every scroll event it works for 120 ms — each scrolled frame waits on it.
	let seen = $state(0);
	$effect(() => {
		function heavy_scroll_work() {
			const until = performance.now() + 120;
			while (performance.now() < until) {
				// busy: the work a careless handler does per event
			}
			seen++;
		}
		addEventListener('scroll', heavy_scroll_work, { passive: true });
		return () => removeEventListener('scroll', heavy_scroll_work);
	});
</script>

<p class="janky">heavy scroll events: {seen}</p>
