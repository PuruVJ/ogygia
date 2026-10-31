<script lang="ts">
	// Pure CPU burn in the component body: naive trial-division prime count. Runs during SSR
	// inside this component's render function, so the time is attributed to `PrimeSieve` in the
	// profiler's "slowest components" table. `limit` scales the cost.
	let { limit = 400_000 }: { limit?: number } = $props();

	let count = 0;
	let last = 0;
	for (let n = 2; n < limit; n++) {
		let prime = true;
		for (let d = 2; d * d <= n; d++) {
			if (n % d === 0) {
				prime = false;
				break;
			}
		}
		if (prime) {
			count++;
			last = n;
		}
	}
</script>

<p class="prime">
	Primes below {limit.toLocaleString()}: <strong>{count.toLocaleString()}</strong> (largest {last.toLocaleString()})
</p>

<style>
	.prime {
		font-family: ui-monospace, monospace;
		font-size: 0.85rem;
		color: #4a5568;
	}
</style>
