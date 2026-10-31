<script lang="ts">
	// PLANTED early-click: wakes when visible, sits below the fold; the answer key scrolls to it and
	// clicks at once, before it is awake. (A little mount work widens the window; under the long-task line.)
	let count = $state(0);
	if (typeof window !== 'undefined') {
		const until = performance.now() + 35;
		while (performance.now() < until);
	}
</script>

<div data-dt="late-click">
	<button onclick={() => (count += 1)}>late {count}</button>
</div>
