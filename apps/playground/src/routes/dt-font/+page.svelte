<script lang="ts">
	// THE FONT LAB for the devtools answer key: two web fonts, both answered in 1.5 s. 'SlowFace' has
	// no font-display (auto: its text stays invisible until the file arrives) — the plant. 'SwapFace'
	// has font-display: swap (its text shows in a fallback at once) — the decoy. Only 'SlowFace' is named.
	const faces = `<style>
@font-face { font-family: 'SlowFace'; src: url('/dt-font/slow.woff2') format('woff2'); }
@font-face { font-family: 'SwapFace'; src: url('/dt-font/swap.woff2') format('woff2'); font-display: swap; }
</style>`;
</script>

<svelte:head>{@html faces}</svelte:head>

<h1 style="font-family: 'SlowFace', sans-serif">font lab: hidden until the font arrives</h1>
<p style="font-family: 'SwapFace', sans-serif">shown at once in a fallback, then swapped</p>
