<script lang="ts">
	// /dt-thrash's decoy: the same 1,500 widths, all written first, then all read — one layout.
	let box: HTMLDivElement;
	$effect(() => {
		const bars = box.querySelectorAll<HTMLElement>('.bar');
		for (let i = 0; i < bars.length; i++) bars[i].style.width = `${50 + ((i * 37) % 200)}px`;
		let total = 0;
		for (let i = 0; i < bars.length; i++) total += bars[i].offsetWidth;
		box.dataset.total = String(total);
	});
</script>

<div bind:this={box} class="batched">
	{#each { length: 1500 } as _, i (i)}
		<div class="bar" style="height: 2px; background: #3a3; margin: 1px 0">{i}</div>
	{/each}
</div>
