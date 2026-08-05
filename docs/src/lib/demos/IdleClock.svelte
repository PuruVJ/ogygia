<div class="widget">
	<span class="widget-label">Idle clock</span>
	<div class="widget-row">
		<span class="widget-value" style="font-size:1.15rem">{time}</span>
		<button type="button" onclick={() => (ticks += 1)}>Tick {ticks}</button>
	</div>
	<p class="widget-meta">Hydrated after idle</p>
</div>

<script lang="ts">
	let time = $state(new Date().toLocaleTimeString());
	let ticks = $state(0);

	$effect(() => {
		const id = setInterval(() => {
			time = new Date().toLocaleTimeString();
		}, 1000);
		return () => clearInterval(id);
	});
</script>
