<script lang="ts">
	// /dt-leak: starts an interval and a window listener and never takes them back. After an in-app
	// navigation away, both still run — the devtools must name Ticker.
	let n = $state(0);
	let width = $state(0);
	$effect(() => {
		setInterval(() => n++, 100);
		window.addEventListener('resize', () => (width = innerWidth));
	});
</script>

<p data-ticker>ticks {n} · width {width}</p>
