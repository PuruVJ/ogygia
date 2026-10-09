<script lang="ts">
	// /dt-thrash's plant: as it wakes, each of 1,500 bars gets a width and is read back at once — a
	// write then a read, 1,500 times, so the browser lays the page out 1,500 times in one task.
	let box: HTMLDivElement;
	$effect(() => {
		const bars = box.querySelectorAll<HTMLElement>('.bar');
		let total = 0;
		for (let i = 0; i < bars.length; i++) {
			bars[i].style.width = `${50 + ((i * 37) % 200)}px`;
			total += bars[i].offsetWidth;
		}
		box.dataset.total = String(total);
	});
</script>

<div bind:this={box} class="thrash">
	{#each { length: 1500 } as _, i (i)}
		<div class="bar" style="height: 2px; background: #c33; margin: 1px 0">{i}</div>
	{/each}
</div>
