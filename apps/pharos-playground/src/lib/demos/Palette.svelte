<script lang="ts">
	// An interactive island that recolors the whole shell live: drag the hue to rewrite the accent
	// token on :root. Shows an island reaching out to restyle server-rendered content around it.
	let hue = $state(172);
	$effect(() => {
		const root = document.documentElement;
		root.style.setProperty('--ph-accent', `oklch(0.62 0.12 ${hue})`);
		root.style.setProperty('--ph-accent-hover', `oklch(0.55 0.12 ${hue})`);
		return () => {
			root.style.removeProperty('--ph-accent');
			root.style.removeProperty('--ph-accent-hover');
		};
	});
</script>

<div class="demo-palette">
	<label for="hue">Accent hue <b>{hue}°</b></label>
	<input id="hue" type="range" min="0" max="360" bind:value={hue} />
	<div class="swatches">
		{#each [0.95, 0.85, 0.72, 0.62, 0.5, 0.38] as l (l)}
			<span style="background: oklch({l} 0.12 {hue})"></span>
		{/each}
	</div>
</div>

<style>
	.demo-palette {
		display: grid;
		gap: 0.6rem;
		max-width: 22rem;
		padding: 0.9rem 1rem;
		border: 1px solid var(--ph-line, #e4e4e8);
		border-radius: 14px;
		background: var(--ph-bg-subtle, #f7f7f8);
	}
	label {
		font-size: 0.85rem;
		color: var(--ph-text-dim, #55555c);
	}
	label b {
		color: var(--ph-accent, #0d9488);
	}
	input {
		width: 100%;
		accent-color: var(--ph-accent, #0d9488);
	}
	.swatches {
		display: flex;
		gap: 4px;
	}
	.swatches span {
		flex: 1;
		height: 1.6rem;
		border-radius: 6px;
	}
</style>
