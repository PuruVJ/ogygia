<div class="feel" class:feel--static={!matches}>
	<p class="feel-status">
		{width}px · {matches ? 'matched' : 'no match'}
	</p>
	<button type="button" class="feel-btn" disabled={!matches} onclick={() => (taps += 1)}>
		Tap · {taps}
	</button>
</div>

<script lang="ts">
	const QUERY = '(max-width: 600px)';

	let width = $state(0);
	let matches = $state(false);
	let taps = $state(0);

	$effect(() => {
		const mq = window.matchMedia(QUERY);
		const sync = () => {
			width = window.innerWidth;
			matches = mq.matches;
		};
		sync();
		mq.addEventListener('change', sync);
		window.addEventListener('resize', sync);
		return () => {
			mq.removeEventListener('change', sync);
			window.removeEventListener('resize', sync);
		};
	});
</script>
