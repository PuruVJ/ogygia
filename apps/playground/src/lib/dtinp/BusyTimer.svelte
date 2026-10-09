<script lang="ts">
	// PLANTED busy page: its click is quick, but it schedules a 400 ms task a moment later. A click on
	// any other island in that window waits for it: the devtools must say the input waited, and name
	// this island's timer as what held the main thread.
	let armed = $state(false);
	function arm() {
		armed = true;
		setTimeout(function planted_busy_timer() {
			const until = performance.now() + 400;
			while (performance.now() < until) {
				/* planted: a long task from a timer */
			}
			armed = false;
		}, 30);
	}
</script>

<button data-inp="busy" onclick={arm}>Start the timer</button>
<span data-inp-armed>{armed ? 'armed' : 'idle'}</span>
