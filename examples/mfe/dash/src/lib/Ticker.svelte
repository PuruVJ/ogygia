<script lang="ts">
	// Second island, waking on `visible` — proves the SHELL runtime schedules DASH regions
	// by DASH's own wake dials (the shell never chose this).
	let ticks = $state(0);
	$effect(() => {
		const id = setInterval(() => ticks++, 500);
		return () => clearInterval(id);
	});
</script>

<span data-testid="dash-ticker" class="ticker">alive for {ticks} ticks</span>

<style>
	.ticker {
		font-variant-numeric: tabular-nums;
		color: #16a34a;
		font-weight: 600;
	}
</style>
