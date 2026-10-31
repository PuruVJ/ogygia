<script lang="ts">
	// /dt-leak's decoy: the same interval and listener, taken back when it goes (and a `once`
	// listener and a signal-bound one, which take themselves back).
	let n = $state(0);
	let width = $state(0);
	$effect(() => {
		const id = setInterval(() => n++, 100);
		const on_resize = () => (width = innerWidth);
		window.addEventListener('resize', on_resize);
		const ac = new AbortController();
		document.addEventListener('keydown', () => n++, { signal: ac.signal });
		window.addEventListener('load', () => n++, { once: true });
		return () => {
			clearInterval(id);
			window.removeEventListener('resize', on_resize);
			ac.abort();
		};
	});
</script>

<p data-tidy>ticks {n} · width {width}</p>
