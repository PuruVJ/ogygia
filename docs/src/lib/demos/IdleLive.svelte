<div class="feel">
	<p class="feel-status">Idle after {waited}</p>
	<p class="feel-clock">{clock}</p>
</div>

<script lang="ts">
	const started = performance.now();
	let waited = $state('…');
	let clock = $state('--:--:--');

	$effect(() => {
		waited = `${Math.round(performance.now() - started)}ms`;
		const tick = setInterval(() => {
			clock = new Date().toLocaleTimeString();
		}, 1000);
		return () => clearInterval(tick);
	});
</script>
