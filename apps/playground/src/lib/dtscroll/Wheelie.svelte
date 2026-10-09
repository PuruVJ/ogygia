<script lang="ts">
	// /dt-scroll's plant: a wheel listener on its scroll box with no `passive` — the browser must run
	// it before every wheel scroll of the box.
	let box: HTMLDivElement;
	let turns = $state(0);
	$effect(() => {
		const on_wheel = () => turns++;
		box.addEventListener('wheel', on_wheel);
		return () => box.removeEventListener('wheel', on_wheel);
	});
</script>

<div bind:this={box} class="wheelie" style="height: 120px; overflow: auto; border: 1px solid #c33">
	<p style="height: 600px">wheel turns: {turns}</p>
</div>
