<script lang="ts">
	// PLANTED long-hydrate: 140 ms of work while it mounts (one long task). Renders the same on both sides.
	let total = 0;
	if (typeof window !== 'undefined') {
		const until = performance.now() + 140;
		while (performance.now() < until) total++;
	}
	void total;
</script>

<div data-dt="heavy">heavy island</div>
