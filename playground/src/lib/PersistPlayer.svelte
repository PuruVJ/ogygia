<script lang="ts">
	// A persisted island: an ever-ticking "playback" counter. With `persist: 'player'` the SAME live
	// app + DOM relocate across SPA navigations, so playback never resets and never skips a beat.
	let { track = 'none' }: { track?: string } = $props();
	let ticks = $state(0);
	// Runs for the app's whole life — proves the app was NOT remounted across navigation.
	$effect(() => {
		const h = setInterval(() => (ticks += 1), 100);
		return () => clearInterval(h);
	});
</script>

<div class="island" data-persist-player>
	playing <b data-pp-track>{track}</b> · ticks <b data-pp-ticks>{ticks}</b>
</div>
