<script lang="ts">
	// /dt-jank's decoy: it follows the scroll too, but once per frame and with almost nothing to do.
	let y = $state(0);
	$effect(() => {
		let queued = false;
		function light_scroll_read() {
			if (queued) return;
			queued = true;
			requestAnimationFrame(() => {
				queued = false;
				y = Math.round(scrollY);
			});
		}
		addEventListener('scroll', light_scroll_read, { passive: true });
		return () => removeEventListener('scroll', light_scroll_read);
	});
</script>

<p class="calm">scrolled to {y}</p>
