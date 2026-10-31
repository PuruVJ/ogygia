<script lang="ts">
	// Imports nothing that changes between the two builds: its entry must keep its name (and cache).
	let woke = $state(false);
	$effect(() => {
		woke = true;
	});
</script>

<p data-probe="steady" data-ran={woke ? 'steady' : undefined}>steady: {woke ? 'awake' : 'asleep'}</p>
