<script lang="ts">
	// /dt-scroll's decoys: the same wheel listener with `passive: true`, and one on `window` with no
	// option (the browser makes a window's passive by itself). Neither holds scrolling.
	let box: HTMLDivElement;
	let turns = $state(0);
	$effect(() => {
		const on_wheel = () => turns++;
		box.addEventListener('wheel', on_wheel, { passive: true });
		window.addEventListener('wheel', on_wheel);
		return () => {
			box.removeEventListener('wheel', on_wheel);
			window.removeEventListener('wheel', on_wheel);
		};
	});
</script>

<div bind:this={box} class="smooth" style="height: 120px; overflow: auto; border: 1px solid #3a3">
	<p style="height: 600px">wheel turns: {turns}</p>
</div>
